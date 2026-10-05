import { fail, record, equal } from './io';
import { repositoryEndpoint } from './observation';
import type { ReadOnlyClientType } from './observation';
import type { ReleaseIdentityType } from './schema';

const verifyProvider = async (identity: ReleaseIdentityType, client: ReadOnlyClientType, requireWriteAccess: boolean): Promise<void> => {
  const endpoint = repositoryEndpoint(identity);
  const repository = await client.json(endpoint);
  if (!record(repository) || repository.full_name !== identity.repository || typeof repository.default_branch !== 'string'
    || (requireWriteAccess && (!record(repository.permissions) || repository.permissions.push !== true))) fail('provider-publication-suitability-unknown-or-unsupported');
  const head = await client.json(`${endpoint}/commits/${encodeURIComponent(repository.default_branch)}`);
  if (!record(head) || typeof head.sha !== 'string' || !/^[a-f0-9]{40}$/.test(head.sha)) fail('provider-publication-suitability-unknown-or-unsupported');
  if (head.sha === identity.source_sha) return;
  const workflows = async (commitSha: string): Promise<Record<string, string>> => {
    const commit = await client.json(`${endpoint}/git/commits/${commitSha}`);
    if (!record(commit) || commit.sha !== commitSha || !record(commit.tree) || typeof commit.tree.sha !== 'string'
      || !/^[a-f0-9]{40}$/.test(commit.tree.sha)) fail('provider-publication-suitability-unknown-or-unsupported');
    const tree = await client.json(`${endpoint}/git/trees/${commit.tree.sha}?recursive=1`);
    if (!record(tree) || tree.sha !== commit.tree.sha || tree.truncated !== false || !Array.isArray(tree.tree)) fail('provider-publication-suitability-unknown-or-unsupported');
    const files: Record<string, string> = {};
    const seen = new Set<string>();
    for (const entry of tree.tree) {
      if (!record(entry) || typeof entry.path !== 'string' || seen.has(entry.path)) fail('provider-publication-suitability-unknown-or-unsupported');
      seen.add(entry.path);
      if (entry.path.startsWith('.github/workflows/')) {
        if (typeof entry.sha !== 'string' || typeof entry.mode !== 'string' || typeof entry.type !== 'string') fail('provider-publication-suitability-unknown-or-unsupported');
        files[entry.path] = `${entry.type}:${entry.mode}:${entry.sha}`;
      }
    }
    return files;
  };
  equal(await workflows(head.sha), await workflows(identity.source_sha), 'provider-publication-suitability-unknown-or-unsupported');
};

export const verifySourceCompatibility = (identity: ReleaseIdentityType, client: ReadOnlyClientType): Promise<void> => verifyProvider(identity, client, false);
export const verifySuitability = (identity: ReleaseIdentityType, client: ReadOnlyClientType): Promise<void> => verifyProvider(identity, client, true);
