import fs from 'node:fs';
import { verifySuitability } from '../../../runtime/release-publication/provider';
import path from 'node:path';
import { Readable } from 'node:stream';
import { loadAssembly, observeBefore, observeReadback, observeAssets, verifyCreatedRelease, GithubReadOnlyClient, remoteId, repositoryEndpoint } from '../../../runtime/release-publication/observation';
import type { ObservationOptionsType, ReadOnlyClientType } from '../../../runtime/release-publication/observation';
import type { AssetType, ReleaseIdentityType, ReceiptType } from '../../../runtime/release-publication/schema';
import { validateEvidence } from '../../../runtime/release-publication/schema';
import { LIMITS, fail, readBytes, readRecord, equal, sha256, safePath, hashFile, record, text, writeNewJson } from '../../../runtime/release-publication/io';
import { parseFutureRfc3339 } from '../../../runtime/release-publication/control';
import { validateReleaseNotesBinding } from '../../../runtime/release-publication/notes-binding';

export type PublisherOptionsType = ObservationOptionsType & { beforePath: string; outputRoot: string };
export type PublisherClientType = ReadOnlyClientType & {
  create(identity: ReleaseIdentityType, body: string): Promise<unknown>;
  upload(identity: ReleaseIdentityType, id: string, asset: AssetType, filename: string): Promise<unknown>;
  finalize(identity: ReleaseIdentityType, id: string): Promise<unknown>;
};


const approvedBody = (options: PublisherOptionsType, identity: ReleaseIdentityType): string => {
  const root = path.dirname(path.resolve(options.authorityPath));
  const request = readRecord(safePath(root, 'publication-request.json'));
  const notes = readRecord(safePath(root, 'release-notes.json'));
  const approval = readRecord(safePath(root, 'release-notes-approval.json'));
  const bound = validateReleaseNotesBinding(notes, approval, identity.tag);
  if (request.releaseIdentity !== identity.tag || request.releaseNotesBodySha256 !== identity.body_sha256
    || bound.bodyDigest !== identity.body_sha256 || request.approvalId !== bound.approvalId) fail('approval-binding-mismatch');
  if (request.schema === 'ci.release-publication-request.v2' && (request.releaseVersion !== identity.version || request.targetIdentity !== identity.target_identity)) fail('approval-binding-mismatch');
  try { parseFutureRfc3339(text(request.approvalExpiresAt)); } catch { fail('approval-expired-or-invalid'); }
  if (typeof notes.body !== 'string') fail('approval-binding-mismatch');
  return notes.body;
};

export const publishRelease = async (options: PublisherOptionsType, client: PublisherClientType): Promise<{ receipt: ReceiptType; receiptPath: string; readbackPath: string }> => {
  const initial = loadAssembly(options);
  const body = approvedBody(options, initial.identity);
  const beforeBytes = readBytes(options.beforePath);
  const before = validateEvidence('observation', JSON.parse(beforeBytes.toString('utf8')));
  equal(before.identity, initial.identity, 'authority-handoff-binding-mismatch');
  if (before.phase !== 'pre-create' || before.handoff_digest !== initial.handoffDigest || before.release_ids.length) fail('existing-release-or-asset');
  if (fs.existsSync(options.outputRoot)) fail('output-already-exists');
  const current = loadAssembly(options);
  equal(current, initial, 'authority-handoff-binding-mismatch');
  await verifySuitability(current.identity, client);
  await observeBefore(options, client);
  if (approvedBody(options, current.identity) !== body) fail('approval-binding-mismatch');
  fs.mkdirSync(options.outputRoot, { recursive: false, mode: 0o700 });
  const created = await client.create(current.identity, body);
  if (!record(created) || created.tag_name !== current.identity.tag || created.draft !== true || created.body !== body) fail('create-result-invalid');
  const id = remoteId(created.id);
  await verifyCreatedRelease(current.identity, id, client);
  for (const asset of current.assembly.assets) {
    const filename = safePath(options.handoffRoot, `assets/${asset.name}`);
    if (fs.statSync(filename).size !== asset.size || hashFile(filename) !== asset.sha256) fail('checksum-mismatch');
    const uploaded = await client.upload(current.identity, id, asset, filename);
    if (!record(uploaded) || uploaded.name !== asset.name || uploaded.size !== asset.size || uploaded.state !== 'uploaded') fail('upload-result-invalid');
    remoteId(uploaded.id);
  }
  await observeAssets(current.identity, id, current.assembly, client);
  await verifySuitability(current.identity, client);
  await verifyCreatedRelease(current.identity, id, client);
  approvedBody(options, current.identity);
  const finalized = await client.finalize(current.identity, id);
  if (!record(finalized) || remoteId(finalized.id) !== id || finalized.tag_name !== current.identity.tag || finalized.draft !== false || finalized.body !== body) fail('finalize-result-invalid');
  const receipt = validateEvidence('receipt', { schema_version: '1', kind: 'ci-github-release-publish-receipt', identity: current.identity,
    handoff_digest: current.handoffDigest, asset_digest: current.assembly.asset_digest, release_id: id, pre_observation_sha256: sha256(beforeBytes) });
  const receiptPath = path.join(options.outputRoot, 'receipt.json');
  const readbackPath = path.join(options.outputRoot, 'readback.json');
  const { evidence } = await observeReadback({ ...options, receiptPath }, client, receipt);
  writeNewJson(readbackPath, evidence);
  writeNewJson(receiptPath, receipt);
  return { receipt, receiptPath, readbackPath };
};

export class GithubPublisherClient extends GithubReadOnlyClient implements PublisherClientType {
  private readonly writeToken: string;
  private readonly writeFetcher: typeof fetch;
  constructor(token: string, fetcher: typeof fetch = fetch) { super(token, fetcher); this.writeToken = token; this.writeFetcher = fetcher; }
  private async write(endpoint: string, method: 'POST' | 'PATCH', body: RequestInit['body'], binarySize?: number): Promise<unknown> {
    if (!/^\/repos\/[^/]+\/[^/]+\/releases(?:\/[1-9][0-9]*(?:\/assets\?name=[^&]+)?)?$/.test(endpoint)) fail('endpoint-invalid');
    const host = binarySize === undefined ? 'api.github.com' : 'uploads.github.com';
    let response: Response;
    try {
      response = await this.writeFetcher(`https://${host}${endpoint}`, { method, body, redirect: 'error', signal: AbortSignal.timeout(LIMITS.timeoutMs),
        headers: { authorization: `Bearer ${this.writeToken}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
          'content-type': binarySize === undefined ? 'application/json' : 'application/octet-stream', ...(binarySize === undefined ? {} : { 'content-length': String(binarySize) }) },
        ...(binarySize === undefined ? {} : { duplex: 'half' }),
      });
    } catch {
      throw new Error(`remote-state-unknown:${JSON.stringify({ operation: binarySize !== undefined ? 'asset-upload' : method === 'POST' ? 'release-create' : 'release-finalize', method,
        'sanitized-endpoint': endpoint.split('?')[0], 'http-status': 'unavailable', 'request-id': 'unavailable', 'sanitized-reason': 'provider-write-result-unknown' })}`);
    }
    if (response.status !== (method === 'POST' ? 201 : 200)) {
      const requestId = response.headers.get('x-github-request-id') ?? '';
      throw new Error(`remote-state-unknown:${JSON.stringify({ operation: binarySize !== undefined ? 'asset-upload' : method === 'POST' ? 'release-create' : 'release-finalize', method,
        'sanitized-endpoint': endpoint.split('?')[0], 'http-status': response.status, 'request-id': /^[A-Za-z0-9:-]{1,100}$/.test(requestId) ? requestId : 'unavailable', 'sanitized-reason': 'provider-write-failed' })}`);
    }
    const unknownResult = (): never => {
      const requestId = response.headers.get('x-github-request-id') ?? '';
      throw new Error(`remote-state-unknown:${JSON.stringify({ operation: binarySize !== undefined ? 'asset-upload' : method === 'POST' ? 'release-create' : 'release-finalize', method,
        'sanitized-endpoint': endpoint.split('?')[0], 'http-status': response.status, 'request-id': /^[A-Za-z0-9:-]{1,100}$/.test(requestId) ? requestId : 'unavailable', 'sanitized-reason': 'provider-write-result-unknown' })}`);
    };
    if (!response.body) unknownResult();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of response.body!) { size += chunk.length; if (size > LIMITS.responseBytes) unknownResult(); chunks.push(Buffer.from(chunk)); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { return unknownResult(); }
  }
  create(identity: ReleaseIdentityType, body: string): Promise<unknown> {
    return this.write(`${repositoryEndpoint(identity)}/releases`, 'POST', JSON.stringify({ tag_name: identity.tag, target_commitish: identity.source_sha, body, draft: true, generate_release_notes: false }));
  }
  async upload(identity: ReleaseIdentityType, id: string, asset: AssetType, filename: string): Promise<unknown> {
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stream = fs.createReadStream(filename, { fd, autoClose: true });
    try { return await this.write(`${repositoryEndpoint(identity)}/releases/${remoteId(id)}/assets?name=${encodeURIComponent(asset.name)}`, 'POST', Readable.toWeb(stream) as ReadableStream, asset.size); }
    finally { stream.destroy(); }
  }
  finalize(identity: ReleaseIdentityType, id: string): Promise<unknown> {
    return this.write(`${repositoryEndpoint(identity)}/releases/${remoteId(id)}`, 'PATCH', JSON.stringify({ draft: false }));
  }
}
