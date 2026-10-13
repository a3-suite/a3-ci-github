import { fail, record, canonicalJson, sha256, diagnosticEndpoint } from './io';
import { repositoryEndpoint, draftVisibilityFailure } from './observation';
import type { ReadOnlyClientType } from './observation';
import type { ReleaseIdentityType } from './schema';

function providerFailure(client: ReadOnlyClientType, endpoint: string, reason: string, comparison: Record<string, unknown> = {}): never {
  const response = client.responseMetadata?.(endpoint);
  const requestId = response?.requestId ?? '';
  return fail('provider-publication-suitability-unknown-or-unsupported', {
    operation: 'remote-observation', phase: 'provider-suitability', method: 'GET',
    'sanitized-endpoint': diagnosticEndpoint(endpoint), 'http-status': response?.status ?? 'unavailable',
    'request-id': /^[A-Za-z0-9:-]{1,100}$/.test(requestId) ? requestId : 'unavailable',
    'sanitized-reason': reason, ...comparison,
  });
}

const verifyProvider = async (identity: ReleaseIdentityType, client: ReadOnlyClientType, requireWriteAccess: boolean): Promise<void> => {
  const endpoint = repositoryEndpoint(identity);
  const repository = await client.json(endpoint);
  if (!record(repository)) providerFailure(client, endpoint, 'response-shape-invalid');
  if (typeof repository.full_name !== 'string' || repository.full_name.toLowerCase() !== identity.repository.toLowerCase()) providerFailure(client, endpoint, 'repository-identity-mismatch');
  if (typeof repository.default_branch !== 'string') providerFailure(client, endpoint, 'default-branch-invalid');
  const visibilityFailure = requireWriteAccess ? draftVisibilityFailure(repository, identity, client) : undefined;
  if (visibilityFailure) providerFailure(client, endpoint, visibilityFailure);
  const headEndpoint = `${endpoint}/commits/${encodeURIComponent(repository.default_branch)}`;
  const head = await client.json(headEndpoint);
  if (!record(head) || typeof head.sha !== 'string' || !/^[a-f0-9]{40}$/.test(head.sha)) providerFailure(client, headEndpoint, 'source-head-invalid');
  if (head.sha === identity.source_sha) return;
  const workflows = async (commitSha: string): Promise<{ files: Record<string, string>; endpoint: string }> => {
    const commitEndpoint = `${endpoint}/git/commits/${commitSha}`;
    const commit = await client.json(commitEndpoint);
    if (!record(commit) || commit.sha !== commitSha || !record(commit.tree) || typeof commit.tree.sha !== 'string'
      || !/^[a-f0-9]{40}$/.test(commit.tree.sha)) providerFailure(client, commitEndpoint, 'commit-response-invalid');
    const treeEndpoint = `${endpoint}/git/trees/${commit.tree.sha}?recursive=1`;
    const tree = await client.json(treeEndpoint);
    if (!record(tree) || tree.sha !== commit.tree.sha || !Array.isArray(tree.tree)) providerFailure(client, treeEndpoint, 'workflow-tree-invalid');
    if (tree.truncated !== false) providerFailure(client, treeEndpoint, 'workflow-tree-incomplete');
    const files: Record<string, string> = {};
    const seen = new Set<string>();
    for (const entry of tree.tree) {
      if (!record(entry) || typeof entry.path !== 'string') providerFailure(client, treeEndpoint, 'workflow-tree-entry-invalid');
      if (seen.has(entry.path)) providerFailure(client, treeEndpoint, 'workflow-tree-duplicate-path');
      seen.add(entry.path);
      if (entry.path.startsWith('.github/workflows/')) {
        if (typeof entry.sha !== 'string' || typeof entry.mode !== 'string' || typeof entry.type !== 'string') providerFailure(client, treeEndpoint, 'workflow-tree-entry-invalid');
        files[entry.path] = `${entry.type}:${entry.mode}:${entry.sha}`;
      }
    }
    return { files, endpoint: treeEndpoint };
  };
  const observed = await workflows(head.sha);
  const expected = await workflows(identity.source_sha);
  if (canonicalJson(expected.files) !== canonicalJson(observed.files)) providerFailure(client, observed.endpoint, 'workflow-source-mismatch', {
    field: 'provider-workflow-set', expected_sha256: sha256(Buffer.from(canonicalJson(expected.files))),
    observed_sha256: sha256(Buffer.from(canonicalJson(observed.files))),
  });
};

export const verifySourceCompatibility = (identity: ReleaseIdentityType, client: ReadOnlyClientType): Promise<void> => verifyProvider(identity, client, false);
export const verifySuitability = (identity: ReleaseIdentityType, client: ReadOnlyClientType): Promise<void> => verifyProvider(identity, client, true);
