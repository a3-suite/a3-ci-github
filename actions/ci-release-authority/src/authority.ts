import fs from 'node:fs';
import path from 'node:path';
import { runControl } from '../../../runtime/release-publication/control';
import { validateReleaseNotesBinding } from '../../../runtime/release-publication/notes-binding';
import { FailureContext } from '../../../runtime/diagnostics/failure.mjs';
import { fail, text, hex, record, readBytes, readRecord, safePath, sha256, writeNewJson } from '../../../runtime/release-publication/io';
import { validateSnapshot } from '../../../runtime/release-publication/snapshot';
import { validateEvidence } from '../../../runtime/release-publication/schema';
import { remoteId } from '../../../runtime/release-publication/observation';
import type { ReadOnlyClientType } from '../../../runtime/release-publication/observation';
import { verifySourceCompatibility } from '../../../runtime/release-publication/provider';
import { sourceTextSha256 } from '../../../runtime/platform/source-text.mjs';

export type AuthorityOptions = { rootDirectory: string; snapshotPath: string; outputDirectory: string; repository: string; requestRunId: string; publicationRequestRunId: string };
export const OWNER_HANDOFF_PATH = '.github/workflows/release-publication-request.yml';
// Observed values come from unvalidated files and API responses; nested values may carry notes or credentials.
const diagnosticValue = (value: unknown): unknown => value === undefined ? 'absent'
  : value === null || ['string', 'number', 'boolean'].includes(typeof value) ? value : `type:${Array.isArray(value) ? 'array' : typeof value}`;
export const validateReleaseDecision = (request: Record<string, unknown>): { version: string; tag: string; targetIdentity: string } => {
  if (request.schema !== 'ci.release-publication-request.v2') fail('owner-release-decision-missing', { field: 'schema', expected: 'ci.release-publication-request.v2', observed: diagnosticValue(request.schema) });
  const version = text(request.releaseVersion, 'version-invalid');
  const tag = text(request.releaseIdentity, 'tag-invalid');
  const targetIdentity = text(request.targetIdentity, 'target-identity-invalid');
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) fail('owner-release-decision-invalid', { field: 'releaseVersion', expected: 'MAJOR.MINOR.PATCH', observed: version });
  if (tag !== `v${version}`) fail('owner-release-decision-invalid', { field: 'releaseIdentity', expected: `v${version}`, observed: tag });
  if (targetIdentity.length > 200) fail('owner-release-decision-invalid', { field: 'targetIdentity', expected: 'at-most-200-characters', observed: targetIdentity.length });
  return { version, tag, targetIdentity };
};
const remote = async (client: ReadOnlyClientType, endpoint: string): Promise<Record<string, unknown>> => {
  const value = await client.json(endpoint);
  if (!record(value)) fail('remote-state-unknown');
  return value;
};
const verifyRun = (run: Record<string, unknown>, id: string, repository: string, event: string, name: string, workflowPath: string): void => {
  const observedRepository = record(run.repository) && typeof run.repository.full_name === 'string' ? run.repository.full_name.toLowerCase() : 'unavailable';
  const observedPath = typeof run.path === 'string' ? run.path.split('@', 1)[0] : 'unavailable';
  const checks: [string, unknown, unknown][] = [['id', id, remoteId(run.id)], ['conclusion', 'success', run.conclusion], ['event', event, run.event], ['name', name, run.name],
    ['repository', repository.toLowerCase(), observedRepository], ['path', workflowPath, observedPath]];
  const violated = checks.find(([, expected, observed]) => expected !== observed);
  if (violated) fail('request-run-provenance-invalid', { field: `run.${violated[0]}`, run: id, expected: violated[1], observed: diagnosticValue(violated[2]) });
  hex(run.head_sha, 40);
};
export const createAuthority = async (options: AuthorityOptions, client: ReadOnlyClientType, diagnostic = new FailureContext('ci-release-authority', 'release-authority')): Promise<{ authorityPath: string; sourceSha: string; version: string; targetIdentity: string; approvalId: string; bodyDigest: string }> => {
  diagnostic.at('decision-validation', { repository: options.repository, requestRunId: options.requestRunId, publicationRequestRunId: options.publicationRequestRunId });
  const root = path.resolve(text(options.rootDirectory));
  const repository = text(options.repository);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) fail('repository-invalid', { field: 'repository', expected: 'owner/name' });
  for (const [field, id] of [['release-request-run-id', options.requestRunId], ['publication-request-run-id', options.publicationRequestRunId]]) {
    if (!/^[1-9][0-9]{0,19}$/.test(id)) fail('request-run-id-invalid', { field, expected: 'positive-decimal-id' });
  }
  const files = [['request-provenance', 'release-request/release-request.json'], ['request-provenance', 'release-request/release-request.json.sha256'],
    ['decision-validation', 'release-publication-request/request.json'], ['decision-validation', 'release-publication-request/request.json.sha256'],
    ['notes-approval', 'release-notes-handoff/release-notes.json'], ['notes-approval', 'release-notes-handoff/release-notes-approval.json']];
  for (const [stage, filename] of files) { diagnostic.at(stage); readBytes(safePath(root, filename)); }
  diagnostic.at('decision-validation');
  const publication = readRecord(safePath(root, 'release-publication-request/request.json'));
  diagnostic.at('request-provenance');
  const request = readRecord(safePath(root, 'release-request/release-request.json'));
  diagnostic.at('notes-approval');
  const notes = readRecord(safePath(root, 'release-notes-handoff/release-notes.json'));
  const approval = readRecord(safePath(root, 'release-notes-handoff/release-notes-approval.json'));
  diagnostic.at('decision-validation');
  const decision = validateReleaseDecision(publication);
  diagnostic.at('notes-approval', { tag: decision.tag, version: decision.version });
  const bound = validateReleaseNotesBinding(notes, approval, decision.tag);
  diagnostic.at('request-provenance', { approvalId: bound.approvalId });
  const sourceSha = hex(request.source_sha, 40);
  const tagObjectSha = hex(request.tag_object_sha, 40);
  diagnostic.at('request-provenance', { source: sourceSha, tagObject: tagObjectSha });
  if (request.tag_object_type !== 'tag') fail('release-request-invalid', { field: 'tag_object_type', expected: 'tag', observed: diagnosticValue(request.tag_object_type) });
  if (request.version === null ? request.version_resolution !== 'authority' : request.version !== decision.version) {
    fail('release-request-invalid', request.version === null
      ? { field: 'version_resolution', expected: 'authority', observed: diagnosticValue(request.version_resolution) }
      : { field: 'version', expected: decision.version, observed: diagnosticValue(request.version) });
  }
  const endpoint = `/repos/${repository}`;
  diagnostic.at('provider-suitability', { endpoint: 'repository-metadata' });
  const metadata = await remote(client, endpoint);
  if (typeof metadata.full_name !== 'string' || metadata.full_name.toLowerCase() !== repository.toLowerCase() || metadata.archived !== false || metadata.disabled !== false) {
    fail('provider-publication-suitability-unknown-or-unsupported', { field: 'repository-metadata', expected: { full_name: repository.toLowerCase(), archived: false, disabled: false },
      observed: { full_name: typeof metadata.full_name === 'string' ? metadata.full_name.toLowerCase() : 'unavailable', archived: diagnosticValue(metadata.archived), disabled: diagnosticValue(metadata.disabled) } });
  }
  const defaultBranch = text(metadata.default_branch, 'default-branch-unknown');
  diagnostic.at('request-provenance', { endpoint: 'workflow-runs' });
  const publicationRun = await remote(client, `${endpoint}/actions/runs/${options.publicationRequestRunId}`);
  const requestRun = await remote(client, `${endpoint}/actions/runs/${options.requestRunId}`);
  verifyRun(publicationRun, options.publicationRequestRunId, repository, 'workflow_dispatch', 'release-publication-request', OWNER_HANDOFF_PATH);
  verifyRun(requestRun, options.requestRunId, repository, 'push', 'release-request-tag', '.github/workflows/release-request-tag.yml');
  const actorPresent = (actor: unknown): boolean => record(actor) && typeof actor.login === 'string' && Boolean(actor.login);
  const bindings: [string, string, unknown, unknown][] = [['head_branch', options.publicationRequestRunId, defaultBranch, publicationRun.head_branch],
    ['head_sha', options.publicationRequestRunId, publication.workflowHeadSha, publicationRun.head_sha], ['head_sha', options.requestRunId, sourceSha, requestRun.head_sha],
    ['actor', options.publicationRequestRunId, 'present', actorPresent(publicationRun.actor) ? 'present' : 'absent'],
    ['triggering_actor', options.publicationRequestRunId, 'present', actorPresent(publicationRun.triggering_actor) ? 'present' : 'absent']];
  const unbound = bindings.find(([, , expected, observed]) => expected !== observed);
  if (unbound) fail('request-run-provenance-invalid', { field: `run.${unbound[0]}`, run: unbound[1], expected: diagnosticValue(unbound[2]), observed: diagnosticValue(unbound[3]) });
  // Bind the owner's existing receiving workflow, not a copy of their version/branch policy.
  diagnostic.at('workflow-binding', { workflow: OWNER_HANDOFF_PATH, revision: publicationRun.head_sha });
  const ownerBytes = readBytes(safePath(root, OWNER_HANDOFF_PATH));
  const ownerFile = await remote(client, `${endpoint}/contents/${OWNER_HANDOFF_PATH}?ref=${hex(publicationRun.head_sha, 40)}`);
  if (ownerFile.type !== 'file' || ownerFile.encoding !== 'base64' || typeof ownerFile.content !== 'string') fail('owner-contract-inconsistent', { field: 'owner-workflow-content', expected: 'base64-file' });
  const encoded = ownerFile.content.replace(/\n/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length > 1400000) fail('owner-contract-inconsistent', { field: 'owner-workflow-content', expected: 'base64-file' });
  const remoteBytes = Buffer.from(encoded, 'base64');
  if (remoteBytes.toString('base64') !== encoded) fail('owner-contract-inconsistent', { field: 'owner-workflow-content', expected: 'base64-file' });
  if (sha256(remoteBytes) !== sha256(ownerBytes)) fail('owner-contract-inconsistent', { field: 'owner-workflow-sha256', expected: sha256(remoteBytes), observed: sha256(ownerBytes) });
  // Existing control owns sidecar, run/source, notes, approval ID and expiry checks.
  const metadataRoot = path.join(root, 'run-metadata');
  diagnostic.at('request-provenance', { endpoint: 'run-metadata' });
  if (fs.existsSync(metadataRoot)) fail('run-metadata-output-already-exists', { field: 'run-metadata', expected: 'absent', observed: 'present' });
  fs.mkdirSync(metadataRoot);
  writeNewJson(path.join(metadataRoot, 'publication-request.json'), publicationRun);
  writeNewJson(path.join(metadataRoot, 'release-request.json'), requestRun);
  runControl({ operation: 'verify-provenance', rootDirectory: root, publicationRequestRunId: options.publicationRequestRunId, releaseRequestRunId: options.requestRunId, approvalId: bound.approvalId, approvalBodySha256: bound.bodyDigest, releaseRequestTagWorkflowName: 'release-request-tag', releaseRequestTagWorkflowPath: '.github/workflows/release-request-tag.yml' });
  diagnostic.at('tag-source', { endpoint: 'git-refs' });
  const ref = await remote(client, `${endpoint}/git/ref/tags/${encodeURIComponent(decision.tag)}`);
  const refObject = record(ref.object) ? { type: diagnosticValue(ref.object.type), sha: diagnosticValue(ref.object.sha) } : 'absent';
  if (!record(ref.object) || ref.object.type !== 'tag' || ref.object.sha !== tagObjectSha) fail('source-or-tag-inconsistent', { field: 'tag-ref.object', expected: { type: 'tag', sha: tagObjectSha }, observed: refObject });
  const tag = await remote(client, `${endpoint}/git/tags/${tagObjectSha}`);
  const tagObject = record(tag.object) ? { type: diagnosticValue(tag.object.type), sha: diagnosticValue(tag.object.sha) } : 'absent';
  if (tag.sha !== tagObjectSha || tag.tag !== decision.tag || !record(tag.object) || tag.object.type !== 'commit' || tag.object.sha !== sourceSha) {
    fail('source-or-tag-inconsistent', { field: 'tag-object', expected: { sha: tagObjectSha, tag: decision.tag, object: { type: 'commit', sha: sourceSha } }, observed: { sha: diagnosticValue(tag.sha), tag: diagnosticValue(tag.tag), object: tagObject } });
  }
  const commit = await remote(client, `${endpoint}/git/commits/${sourceSha}`);
  if (commit.sha !== sourceSha) fail('source-inconsistent', { field: 'commit.sha', expected: sourceSha, observed: diagnosticValue(commit.sha) });
  diagnostic.at('snapshot-validation', { input: 'snapshot-path' });
  const snapshot = readRecord(safePath(root, options.snapshotPath));
  const values = validateSnapshot(snapshot, { config_snapshot_digest: snapshot.digest });
  if (values.CI_RELEASE_OWNER_CONTRACT !== 'git.release-flow' || values.CI_RELEASE_IMPLEMENTATION !== 'rust-cli-release' || values.CI_LANGUAGE_PROFILE !== 'rust') {
    fail('owner-contract-inconsistent', { field: 'snapshot-release-selection', expected: { CI_RELEASE_OWNER_CONTRACT: 'git.release-flow', CI_RELEASE_IMPLEMENTATION: 'rust-cli-release', CI_LANGUAGE_PROFILE: 'rust' },
      observed: { CI_RELEASE_OWNER_CONTRACT: diagnosticValue(values.CI_RELEASE_OWNER_CONTRACT), CI_RELEASE_IMPLEMENTATION: diagnosticValue(values.CI_RELEASE_IMPLEMENTATION), CI_LANGUAGE_PROFILE: diagnosticValue(values.CI_LANGUAGE_PROFILE) } });
  }
  const manifestPath = text(values.CI_PLATFORM_MANIFEST, 'platform-manifest-invalid');
  const manifestDigest = sourceTextSha256(readBytes(safePath(root, manifestPath)));
  const toolchain = text(values.CI_TOOLCHAIN_VERSION, 'toolchain-invalid');
  if (toolchain.includes('<') || toolchain === '__unset__') fail('toolchain-invalid', { field: 'CI_TOOLCHAIN_VERSION', expected: 'resolved-toolchain', observed: toolchain });
  const identity = validateEvidence('identity', { repository, tag: decision.tag, tag_object_sha: tagObjectSha, source_sha: sourceSha, version: decision.version, target_identity: decision.targetIdentity, body_sha256: bound.bodyDigest });
  diagnostic.at('provider-suitability', { endpoint: 'source-compatibility' });
  await verifySourceCompatibility(identity, client);
  const authority = { schema: 'ci.release-authority.v1', source_sha: sourceSha, tag_object_sha: tagObjectSha, version: decision.version, tag: decision.tag, target_identity: decision.targetIdentity,
    language_profile: 'rust', toolchain_version: toolchain, platform_manifest: manifestPath, platform_manifest_sha256: manifestDigest,
    config_snapshot_digest: snapshot.digest, owner_contract: { id: 'git.release-flow', handoff_path: OWNER_HANDOFF_PATH, revision: publicationRun.head_sha }, owner_contract_digest: sha256(ownerBytes), publication: identity,
    approval_id: bound.approvalId, approved_body_sha256: bound.bodyDigest, provider_publication_suitability: { status: 'source-compatible', credential_route: 'GITHUB_TOKEN', write_capability: 'not-observed', observed_at: new Date().toISOString() } };
  diagnostic.at('authority-write', { output: 'output-directory' });
  const output = path.resolve(root, text(options.outputDirectory));
  if (fs.existsSync(output) || path.dirname(output) !== root) fail('authority-output-invalid-or-existing', { field: 'output-directory', expected: 'new-direct-child-of-root', observed: fs.existsSync(output) ? 'existing' : 'outside-root' });
  fs.mkdirSync(output, { mode: 0o700 });
  const authorityPath = path.join(output, 'authority.json');
  writeNewJson(authorityPath, authority);
  writeNewJson(path.join(output, 'config-snapshot.json'), snapshot);
  writeNewJson(path.join(output, 'publication-request.json'), publication);
  writeNewJson(path.join(output, 'release-notes.json'), notes);
  writeNewJson(path.join(output, 'release-notes-approval.json'), approval);
  return { authorityPath, sourceSha, version: decision.version, targetIdentity: decision.targetIdentity, approvalId: bound.approvalId, bodyDigest: bound.bodyDigest };
};
