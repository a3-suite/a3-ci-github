export type TagResolution = {
  tagObjectSha: string;
  tagObjectType: 'tag';
  sourceSha: string;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const SHA = /^[0-9a-f]{40}$/;

const requireText = (value: string, error: string): string => {
  if (value.length === 0 || /[\0\r\n]/.test(value)) throw new Error(error);
  return value;
};

const requireRepository = (value: string): string => {
  if (!/^[^/\s]+\/[^/\s]+$/.test(value)) throw new Error('repository-invalid');
  return value;
};

const requireSha = (value: unknown, error: string): string => {
  if (typeof value !== 'string' || !SHA.test(value)) throw new Error(error);
  return value;
};

const readJson = async (response: Response): Promise<unknown> => {
  if (!response.ok) throw new Error(`github-api-http-${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error('github-api-json-invalid');
  }
};

const objectField = (value: unknown, field: string): unknown => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('github-api-payload-invalid');
  return (value as Record<string, unknown>)[field];
};

export const resolveAnnotatedTag = async (
  repository: string,
  tag: string,
  token: string,
  apiUrl: string,
  fetchImpl: FetchLike = fetch,
): Promise<TagResolution> => {
  const repo = requireRepository(repository);
  const tagName = requireText(tag, 'tag-invalid');
  const authToken = requireText(token, 'github-token-required');
  const baseUrl = requireText(apiUrl, 'api-url-invalid').replace(/\/+$/, '');
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${authToken}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const ref = await readJson(await fetchImpl(`${baseUrl}/repos/${repo}/git/ref/tags/${encodeURIComponent(tagName)}`, { headers }));
  const refObject = objectField(ref, 'object');
  if (objectField(refObject, 'type') !== 'tag') throw new Error('annotated-tag-required');
  const tagObjectSha = requireSha(objectField(refObject, 'sha'), 'tag-sha-invalid');
  const tagPayload = await readJson(await fetchImpl(`${baseUrl}/repos/${repo}/git/tags/${tagObjectSha}`, { headers }));
  const sourceObject = objectField(tagPayload, 'object');
  if (objectField(sourceObject, 'type') !== 'commit') throw new Error('tag-dereference-to-commit-required');
  return { tagObjectSha, tagObjectType: 'tag', sourceSha: requireSha(objectField(sourceObject, 'sha'), 'tag-sha-invalid') };
};
