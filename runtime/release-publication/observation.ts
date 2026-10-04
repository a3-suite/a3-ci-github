import { LIMITS, fail, sha256, equal, safePath, readBytes, readJson, readRecord, hashFile, record, writeNewJson } from './io';
import { validateEvidence, identityFromAuthority, assetDigest, sortedAssets } from './schema';
import type { AssetType, AssemblyType, ReleaseIdentityType, ObservationType, ReceiptType, ReadbackType } from './schema';

export type ObservationOptionsType = { authorityPath: string; repository: string; handoffRoot: string };
export type VerificationOptionsType = ObservationOptionsType & { receiptPath: string; readbackPath: string; beforePath: string };
export type ReadOnlyClientType = {
  json(endpoint: string): Promise<unknown>;
  list(endpoint: string): Promise<Record<string, unknown>[]>;
  assetDigest(endpoint: string, size: number): Promise<string>;
};
const remoteRecord = async (client: ReadOnlyClientType, endpoint: string): Promise<Record<string, unknown>> => {
  const value = await client.json(endpoint);
  if (!record(value)) fail('remote-state-unknown');
  return value;
};

export const remoteId = (value: unknown): string => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value)) return value;
  return fail('remote-state-unknown');
};
export const loadAssembly = (options: ObservationOptionsType): { identity: ReleaseIdentityType; assembly: AssemblyType; handoffDigest: string } => {
  const identity = identityFromAuthority(readRecord(options.authorityPath), options.repository);
  const assembly = validateEvidence('assembly', readJson(safePath(options.handoffRoot, 'assembly.json')));
  equal(assembly.identity, identity, 'authority-handoff-binding-mismatch');
  equal(assembly.assets, sortedAssets(assembly.assets), 'asset-set-mismatch');
  if (assembly.asset_digest !== assetDigest(assembly.assets)) fail('asset-set-mismatch');
  const manifestBytes = readBytes(safePath(options.handoffRoot, 'manifest.json'));
  if (assembly.manifest_sha256 !== sha256(manifestBytes)) fail('checksum-mismatch');
  const value: unknown = JSON.parse(manifestBytes.toString('utf8'));
  if (!Array.isArray(value)) fail('asset-set-mismatch');
  const manifest: unknown[] = value;
  if (!Array.isArray(manifest) || !manifest.length || manifest.length > LIMITS.assets * 4) fail('asset-set-mismatch');
  const paths = new Set<string>();
  const entries: Record<string, unknown>[] = [];
  for (const entry of manifest) {
    if (!record(entry) || Object.keys(entry).sort().join(',') !== 'path,sha256' || typeof entry.path !== 'string' || paths.has(entry.path)) fail('asset-set-mismatch');
    paths.add(entry.path);
    entries.push(entry);
    if (hashFile(safePath(options.handoffRoot, entry.path)) !== entry.sha256) fail('checksum-mismatch');
  }
  for (const asset of assembly.assets) {
    if (!entries.some((entry) => entry.path === `assets/${asset.name}` && entry.sha256 === asset.sha256)) fail('asset-set-mismatch');
  }
  const published = entries.filter((entry) => typeof entry.path === 'string' && entry.path.startsWith('assets/'));
  if (published.length !== assembly.assets.length) fail('asset-set-mismatch');
  const descriptor = readRecord(safePath(options.handoffRoot, 'handoff.json'));
  if (descriptor.schema !== 'ci.handoff.v1' || descriptor.source_sha !== identity.source_sha
    || descriptor.version !== identity.version || descriptor.target_identity !== identity.target_identity || descriptor.manifest !== 'manifest.json') fail('authority-handoff-binding-mismatch');
  return { identity, assembly, handoffDigest: sha256(readBytes(safePath(options.handoffRoot, 'handoff.json'))) };
};
const boundedBody = async (response: Response, maximum: number): Promise<Buffer> => {
  if (!response.body) fail('remote-state-unknown');
  const parts: Buffer[] = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > maximum) fail('remote-state-unknown');
    parts.push(Buffer.from(chunk));
  }
  return Buffer.concat(parts);
};
export class GithubReadOnlyClient implements ReadOnlyClientType {
  private readonly token: string;
  private readonly fetcher: typeof fetch;
  constructor(token: unknown, fetcher: typeof fetch = fetch) {
    if (typeof token !== 'string' || !token || /[\r\n\0]/.test(token)) fail('credential-missing');
    this.token = token;
    this.fetcher = fetcher;
  }
  async request(endpoint: string, binary = false): Promise<Response> {
    if (!endpoint.startsWith('/repos/') || /[\r\n\0]/.test(endpoint)) fail('endpoint-invalid');
    let response;
    try {
      response = await this.fetcher(`https://api.github.com${endpoint}`, {
        method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(LIMITS.timeoutMs),
        headers: { authorization: `Bearer ${this.token}`, accept: binary ? 'application/octet-stream' : 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
      });
      if (binary && response.status === 302) {
        const location = response.headers.get('location');
        if (!location) fail('remote-state-unknown');
        const redirect = new URL(location);
        if (redirect.protocol !== 'https:' || redirect.hostname !== 'release-assets.githubusercontent.com' || redirect.username || redirect.password || redirect.port) fail('remote-state-unknown');
        response = await this.fetcher(redirect, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(LIMITS.timeoutMs) });
      }
      if (response.status !== 200) {
        const requestId = response.headers.get('x-github-request-id') ?? 'unavailable';
        // Only provider operation identity is exposed; response bodies and signed URLs are never diagnostics.
        const diagnostic = { operation: binary ? 'asset-readback' : 'remote-observation', method: 'GET', 'sanitized-endpoint': endpoint.split('?')[0], 'http-status': response.status, 'request-id': /^[A-Za-z0-9:-]{1,100}$/.test(requestId) ? requestId : 'unavailable', 'sanitized-reason': 'provider-read-failed' };
        throw new Error(`remote-state-unknown:${JSON.stringify(diagnostic)}`);
      }
      return response;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('remote-state-unknown:')) throw error;
      return fail('remote-state-unknown');
    }
  }
  async json(endpoint: string): Promise<unknown> {
    const response = await this.request(endpoint);
    try { return JSON.parse((await boundedBody(response, LIMITS.responseBytes)).toString('utf8')); } catch { return fail('remote-state-unknown'); }
  }
  async list(endpoint: string): Promise<Record<string, unknown>[]> {
    const result: Record<string, unknown>[] = [];
    const ids = new Set();
    for (let page = 1; page <= LIMITS.pages; page += 1) {
      const entries = await this.json(`${endpoint}?per_page=100&page=${page}`);
      if (!Array.isArray(entries) || entries.length > 100) fail('remote-state-unknown');
      const values: unknown[] = entries;
      for (const entry of values) {
        if (!record(entry)) fail('remote-state-unknown');
        const id = remoteId(entry.id);
        if (ids.has(id)) fail('remote-state-unknown');
        ids.add(id);
        result.push(entry);
      }
      if (entries.length < 100) return result;
    }
    return fail('remote-state-unknown');
  }
  async assetDigest(endpoint: string, size: number): Promise<string> {
    const response = await this.request(endpoint, true);
    if (!response.body) fail('remote-state-unknown');
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256');
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > size || length > LIMITS.assetBytes) fail('checksum-mismatch');
      hash.update(chunk);
    }
    if (length !== size) fail('checksum-mismatch');
    return hash.digest('hex');
  }
}
export const repositoryEndpoint = (identity: ReleaseIdentityType): string => `/repos/${identity.repository.split('/').map(encodeURIComponent).join('/')}`;
const observeInventory = async (client: ReadOnlyClientType, identity: ReleaseIdentityType): Promise<string[]> => {
  const endpoint = repositoryEndpoint(identity);
  const repository = await remoteRecord(client, endpoint);
  // GitHub draft visibility requires push access. A published-only read cannot prove absence.
  if (typeof repository.full_name !== 'string' || repository.full_name.toLowerCase() !== identity.repository.toLowerCase() || !record(repository.permissions) || repository.permissions.push !== true) fail('remote-state-unknown');
  return (await client.list(`${endpoint}/releases`)).filter((release) => {
    if (typeof release.tag_name !== 'string' || typeof release.draft !== 'boolean') fail('remote-state-unknown');
    return release.tag_name === identity.tag;
  }).map((release) => remoteId(release.id));
};
const verifyTag = async (client: ReadOnlyClientType, identity: ReleaseIdentityType): Promise<void> => {
  const endpoint = repositoryEndpoint(identity);
  const ref = await remoteRecord(client, `${endpoint}/git/ref/tags/${encodeURIComponent(identity.tag)}`);
  if (!record(ref.object) || ref.object.type !== 'tag' || ref.object.sha !== identity.tag_object_sha) fail('source-identity-mismatch');
  const object = await remoteRecord(client, `${endpoint}/git/tags/${identity.tag_object_sha}`);
  if (object.sha !== identity.tag_object_sha || !record(object.object) || object.object.type !== 'commit' || object.object.sha !== identity.source_sha) fail('source-identity-mismatch');
};
const observation = (identity: ReleaseIdentityType, handoffDigest: string, phase: ObservationType['phase'], releaseIds: string[]): ObservationType => validateEvidence('observation', {
  schema_version: '1', kind: 'ci-github-release-observation', identity, handoff_digest: handoffDigest,
  phase, complete: true, visibility: 'public-and-non-public', release_ids: releaseIds,
});
export const observeBefore = async (options: ObservationOptionsType, client: ReadOnlyClientType): Promise<ObservationType> => {
  const { identity, handoffDigest } = loadAssembly(options);
  await verifyTag(client, identity);
  const ids = await observeInventory(client, identity);
  if (ids.length !== 0) fail('existing-release-or-asset');
  return observation(identity, handoffDigest, 'pre-create', ids);
};
export const verifyCreatedRelease = async (identity: ReleaseIdentityType, releaseId: string, client: ReadOnlyClientType): Promise<void> => {
  await verifyTag(client, identity);
  await observeUniqueRelease(identity, releaseId, client);
};
const observeUniqueRelease = async (identity: ReleaseIdentityType, releaseId: string, client: ReadOnlyClientType): Promise<string[]> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const ids = await observeInventory(client, identity);
    if (ids.length > 1 || (ids.length === 1 && ids[0] !== releaseId)) fail('existing-release-or-asset');
    if (ids.length === 1) return ids;
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return fail('remote-state-unknown');
};
export const observeAssets = async (identity: ReleaseIdentityType, releaseId: string, assembly: AssemblyType, client: ReadOnlyClientType): Promise<AssetType[]> => {
  const endpoint = repositoryEndpoint(identity);
  const remoteAssets = await client.list(`${endpoint}/releases/${releaseId}/assets`);
  if (remoteAssets.length !== assembly.assets.length) fail('asset-set-mismatch');
  const names = new Set();
  const assets: AssetType[] = [];
  for (const remote of remoteAssets) {
    const expected = assembly.assets.find((asset) => asset.name === remote.name);
    if (!expected || names.has(remote.name) || remote.size !== expected.size || remote.state !== 'uploaded') fail('asset-set-mismatch');
    names.add(expected.name);
    const digest = await client.assetDigest(`${endpoint}/releases/assets/${remoteId(remote.id)}`, expected.size);
    if (digest !== expected.sha256) fail('checksum-mismatch');
    assets.push({ name: expected.name, size: expected.size, sha256: digest });
  }
  return sortedAssets(assets);
};
export const observeReadback = async (options: Omit<VerificationOptionsType, 'readbackPath'>, client: ReadOnlyClientType, suppliedReceipt?: ReceiptType): Promise<{ receipt: ReceiptType; evidence: ReadbackType }> => {
  const { identity, assembly, handoffDigest } = loadAssembly(options);
  const receipt = validateEvidence('receipt', suppliedReceipt ?? readJson(options.receiptPath));
  const beforeBytes = readBytes(options.beforePath);
  const before = validateEvidence('observation', JSON.parse(beforeBytes.toString('utf8')));
  equal(before.identity, identity, 'authority-handoff-binding-mismatch');
  if (before.handoff_digest !== handoffDigest || before.phase !== 'pre-create' || before.release_ids.length !== 0) fail('existing-release-or-asset');
  equal(receipt.identity, identity, 'authority-handoff-binding-mismatch');
  if (receipt.handoff_digest !== handoffDigest || receipt.asset_digest !== assembly.asset_digest || receipt.pre_observation_sha256 !== sha256(beforeBytes)) fail('receipt-mismatch');
  const endpoint = repositoryEndpoint(identity);
  const release = await remoteRecord(client, `${endpoint}/releases/${receipt.release_id}`);
  if (remoteId(release.id) !== receipt.release_id || release.tag_name !== identity.tag || release.draft !== false || typeof release.body !== 'string'
    || sha256(Buffer.from(release.body)) !== identity.body_sha256) fail('tag-version-asset-checksum-or-body-mismatch');
  await verifyTag(client, identity);
  const assets = await observeAssets(identity, receipt.release_id, assembly, client);
  const ids = await observeUniqueRelease(identity, receipt.release_id, client);
  const evidence = validateEvidence('readback', {
    schema_version: '1', kind: 'ci-github-release-readback', identity, handoff_digest: handoffDigest,
    asset_digest: assembly.asset_digest, release_id: receipt.release_id, draft: false, assets: sortedAssets(assets),
    inventory: observation(identity, handoffDigest, 'post-create', ids),
  });
  return { receipt, evidence };
};
export const saveObservation = (filename: string, value: ObservationType): void => writeNewJson(filename, value);

export const verifyAfter = async (options: VerificationOptionsType, client: ReadOnlyClientType): Promise<{ receipt: ReceiptType; evidence: ReadbackType }> => {
  const supplied = validateEvidence('readback', readJson(options.readbackPath));
  const result = await observeReadback(options, client);
  equal(supplied, result.evidence, 'readback-evidence-mismatch');
  return result;
};
