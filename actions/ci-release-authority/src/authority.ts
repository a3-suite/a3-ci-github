import fs from 'node:fs';
import path from 'node:path';
import { runControl } from '../../../runtime/release-publication/control';
import { validateReleaseNotesBinding } from '../../../runtime/release-publication/notes-binding';
import { fail, text, hex, record, readBytes, readRecord, safePath, sha256, writeNewJson } from '../../../runtime/release-publication/io';
import { validateSnapshot } from '../../../runtime/release-publication/snapshot';
import { validateEvidence } from '../../../runtime/release-publication/schema';
import { remoteId } from '../../../runtime/release-publication/observation';
import type { ReadOnlyClientType } from '../../../runtime/release-publication/observation';
import { verifySourceCompatibility } from '../../../runtime/release-publication/provider';

export type AuthorityOptions = { rootDirectory: string; snapshotPath: string; outputDirectory: string; repository: string; requestRunId: string; publicationRequestRunId: string };
export const OWNER_HANDOFF_PATH = '.github/workflows/release-publication-request.yml';
export const validateReleaseDecision = (request: Record<string, unknown>): { version: string; tag: string; targetIdentity: string } => {
  if (request.schema !== 'ci.release-publication-request.v2') fail('owner-release-decision-missing');
  const version = text(request.releaseVersion, 'version-invalid');
  const tag = text(request.releaseIdentity, 'tag-invalid');
  const targetIdentity = text(request.targetIdentity, 'target-identity-invalid');
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version) || tag !== `v${version}` || targetIdentity.length > 200) fail('owner-release-decision-invalid');
  return { version, tag, targetIdentity };
};
const remote = async (client: ReadOnlyClientType, endpoint: string): Promise<Record<string, unknown>> => {
  const value = await client.json(endpoint);
  if (!record(value)) fail('remote-state-unknown');
  return value;
};
const verifyRun = (run: Record<string, unknown>, id: string, repository: string, event: string, name: string, workflowPath: string): void => {
  if (remoteId(run.id) !== id || run.conclusion !== 'success' || run.event !== event || run.name !== name
    || !record(run.repository) || run.repository.full_name !== repository || typeof run.path !== 'string'
    || run.path.split('@', 1)[0] !== workflowPath) fail('request-run-provenance-invalid');
  hex(run.head_sha, 40);
};
export const createAuthority = async (options: AuthorityOptions, client: ReadOnlyClientType): Promise<{ authorityPath: string; sourceSha: string; version: string; targetIdentity: string; approvalId: string; bodyDigest: string }> => {
  const root = path.resolve(text(options.rootDirectory));
  const repository = text(options.repository);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) fail('repository-invalid');
  if (![options.requestRunId, options.publicationRequestRunId].every((id) => /^[1-9][0-9]{0,19}$/.test(id))) fail('request-run-id-invalid');
  const files = ['release-request/release-request.json', 'release-request/release-request.json.sha256', 'release-publication-request/request.json', 'release-publication-request/request.json.sha256', 'release-notes-handoff/release-notes.json', 'release-notes-handoff/release-notes-approval.json'];
  for (const filename of files) readBytes(safePath(root, filename));
  const publication = readRecord(safePath(root, 'release-publication-request/request.json'));
  const request = readRecord(safePath(root, 'release-request/release-request.json'));
  const notes = readRecord(safePath(root, 'release-notes-handoff/release-notes.json'));
  const approval = readRecord(safePath(root, 'release-notes-handoff/release-notes-approval.json'));
  const decision = validateReleaseDecision(publication);
  const bound = validateReleaseNotesBinding(notes, approval, decision.tag);
  const sourceSha = hex(request.source_sha, 40);
  const tagObjectSha = hex(request.tag_object_sha, 40);
  if (request.tag_object_type !== 'tag' || (request.version === null ? request.version_resolution !== 'authority' : request.version !== decision.version)) fail('release-request-invalid');
  const endpoint = `/repos/${repository}`;
  const metadata = await remote(client, endpoint);
  if (metadata.full_name !== repository || metadata.archived !== false || metadata.disabled !== false) fail('provider-publication-suitability-unknown-or-unsupported');
  const defaultBranch = text(metadata.default_branch, 'default-branch-unknown');
  const publicationRun = await remote(client, `${endpoint}/actions/runs/${options.publicationRequestRunId}`);
  const requestRun = await remote(client, `${endpoint}/actions/runs/${options.requestRunId}`);
  verifyRun(publicationRun, options.publicationRequestRunId, repository, 'workflow_dispatch', 'release-publication-request', OWNER_HANDOFF_PATH);
  verifyRun(requestRun, options.requestRunId, repository, 'push', 'release-request-tag', '.github/workflows/release-request-tag.yml');
  if (publicationRun.head_branch !== defaultBranch || publicationRun.head_sha !== publication.workflowHeadSha
    || requestRun.head_sha !== sourceSha || !record(publicationRun.actor) || !record(publicationRun.triggering_actor)
    || typeof publicationRun.actor.login !== 'string' || !publicationRun.actor.login
    || typeof publicationRun.triggering_actor.login !== 'string' || !publicationRun.triggering_actor.login) fail('request-run-provenance-invalid');
  // Bind the owner's existing receiving workflow, not a copy of their version/branch policy.
  const ownerBytes = readBytes(safePath(root, OWNER_HANDOFF_PATH));
  const ownerFile = await remote(client, `${endpoint}/contents/${OWNER_HANDOFF_PATH}?ref=${hex(publicationRun.head_sha, 40)}`);
  if (ownerFile.type !== 'file' || ownerFile.encoding !== 'base64' || typeof ownerFile.content !== 'string') fail('owner-contract-inconsistent');
  const encoded = ownerFile.content.replace(/\n/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length > 1400000) fail('owner-contract-inconsistent');
  const remoteBytes = Buffer.from(encoded, 'base64');
  if (remoteBytes.toString('base64') !== encoded || sha256(remoteBytes) !== sha256(ownerBytes)) fail('owner-contract-inconsistent');
  // Existing control owns sidecar, run/source, notes, approval ID and expiry checks.
  const metadataRoot = path.join(root, 'run-metadata');
  if (fs.existsSync(metadataRoot)) fail('run-metadata-output-already-exists');
  fs.mkdirSync(metadataRoot);
  writeNewJson(path.join(metadataRoot, 'publication-request.json'), publicationRun);
  writeNewJson(path.join(metadataRoot, 'release-request.json'), requestRun);
  runControl({ operation: 'verify-provenance', rootDirectory: root, publicationRequestRunId: options.publicationRequestRunId, releaseRequestRunId: options.requestRunId, approvalId: bound.approvalId, approvalBodySha256: bound.bodyDigest, releaseRequestTagWorkflowName: 'release-request-tag', releaseRequestTagWorkflowPath: '.github/workflows/release-request-tag.yml' });
  const ref = await remote(client, `${endpoint}/git/ref/tags/${encodeURIComponent(decision.tag)}`);
  if (!record(ref.object) || ref.object.type !== 'tag' || ref.object.sha !== tagObjectSha) fail('source-or-tag-inconsistent');
  const tag = await remote(client, `${endpoint}/git/tags/${tagObjectSha}`);
  if (tag.sha !== tagObjectSha || tag.tag !== decision.tag || !record(tag.object) || tag.object.type !== 'commit' || tag.object.sha !== sourceSha) fail('source-or-tag-inconsistent');
  const commit = await remote(client, `${endpoint}/git/commits/${sourceSha}`);
  if (commit.sha !== sourceSha) fail('source-inconsistent');
  const snapshot = readRecord(safePath(root, options.snapshotPath));
  const values = validateSnapshot(snapshot, { config_snapshot_digest: snapshot.digest });
  if (values.CI_RELEASE_OWNER_CONTRACT !== 'git.release-flow' || values.CI_RELEASE_IMPLEMENTATION !== 'rust-cli-release'
    || values.CI_LANGUAGE_PROFILE !== 'rust') fail('owner-contract-inconsistent');
  const manifestPath = text(values.CI_PLATFORM_MANIFEST, 'platform-manifest-invalid');
  const manifestDigest = sha256(readBytes(safePath(root, manifestPath)));
  const toolchain = text(values.CI_TOOLCHAIN_VERSION, 'toolchain-invalid');
  if (toolchain.includes('<') || toolchain === '__unset__') fail('toolchain-invalid');
  const identity = validateEvidence('identity', { repository, tag: decision.tag, tag_object_sha: tagObjectSha, source_sha: sourceSha, version: decision.version, target_identity: decision.targetIdentity, body_sha256: bound.bodyDigest });
  await verifySourceCompatibility(identity, client);
  const authority = { schema: 'ci.release-authority.v1', source_sha: sourceSha, tag_object_sha: tagObjectSha, version: decision.version, tag: decision.tag, target_identity: decision.targetIdentity,
    language_profile: 'rust', toolchain_version: toolchain, platform_manifest: manifestPath, platform_manifest_sha256: manifestDigest,
    config_snapshot_digest: snapshot.digest, owner_contract: { id: 'git.release-flow', handoff_path: OWNER_HANDOFF_PATH, revision: publicationRun.head_sha }, owner_contract_digest: sha256(ownerBytes), publication: identity,
    approval_id: bound.approvalId, approved_body_sha256: bound.bodyDigest, provider_publication_suitability: { status: 'source-compatible', credential_route: 'GITHUB_TOKEN', write_capability: 'not-observed', observed_at: new Date().toISOString() } };
  const output = path.resolve(root, text(options.outputDirectory));
  if (fs.existsSync(output) || path.dirname(output) !== root) fail('authority-output-invalid-or-existing');
  fs.mkdirSync(output, { mode: 0o700 });
  const authorityPath = path.join(output, 'authority.json');
  writeNewJson(authorityPath, authority);
  writeNewJson(path.join(output, 'config-snapshot.json'), snapshot);
  writeNewJson(path.join(output, 'publication-request.json'), publication);
  writeNewJson(path.join(output, 'release-notes.json'), notes);
  writeNewJson(path.join(output, 'release-notes-approval.json'), approval);
  return { authorityPath, sourceSha, version: decision.version, targetIdentity: decision.targetIdentity, approvalId: bound.approvalId, bodyDigest: bound.bodyDigest };
};
