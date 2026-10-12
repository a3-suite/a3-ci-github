import { DiagnosticError, FailureContext } from '../../../runtime/diagnostics/failure.mjs';
export type TagResolution = {
  tagObjectSha: string;
  tagObjectType: 'tag';
  sourceSha: string;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const SHA = /^[0-9a-f]{40}$/;

const requireText = (value: string, error: string): string => {
  if (value.length === 0 || /[\0\r\n]/.test(value)) throw new DiagnosticError(error);
  return value;
};

const requireRepository = (value: string): string => {
  if (!/^[^/\s]+\/[^/\s]+$/.test(value)) throw new DiagnosticError('repository-invalid');
  return value;
};

const requireSha = (value: unknown, error: string): string => {
  if (typeof value !== 'string' || !SHA.test(value)) throw new DiagnosticError(error);
  return value;
};

const readJson = async (response: Response, diagnostic: FailureContext): Promise<unknown> => {
  const requestId = response.headers?.get('x-github-request-id');
  const comparison = { field: 'github-api-response', expected: 'successful-json-response', observed: response.status, method: 'GET', requestId: requestId && /^[A-Za-z0-9:-]{1,100}$/.test(requestId) ? requestId : 'unavailable' };
  diagnostic.details.httpStatus = response.status;
  diagnostic.details.requestId = comparison.requestId;
  if (!response.ok) throw new DiagnosticError(`github-api-http-${response.status}`, { diagnostics: comparison });
  try {
    return await response.json();
  } catch {
    throw new DiagnosticError('github-api-json-invalid', { diagnostics: { field: 'github-api-response', expected: 'json', observed: 'invalid-json' } });
  }
};

const objectField = (value: unknown, field: string): unknown => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new DiagnosticError('github-api-payload-invalid');
  return (value as Record<string, unknown>)[field];
};

export const resolveAnnotatedTag = async (
  repository: string,
  tag: string,
  token: string,
  apiUrl: string,
  fetchImpl: FetchLike = fetch,
): Promise<TagResolution> => {
  const diagnostic = new FailureContext('ci-annotated-tag-resolver', 'annotated-tag-resolver');
  try {
  const repo = requireRepository(repository);
  const tagName = requireText(tag, 'tag-invalid');
  const authToken = requireText(token, 'github-token-required');
  const baseUrl = requireText(apiUrl, 'api-url-invalid').replace(/\/+$/, '');
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${authToken}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  diagnostic.confirmed();
  diagnostic.at('tag-ref-observation', { repository: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ? repo : 'protected-or-invalid', tag: /^[A-Za-z0-9_.\/-]{1,200}$/.test(tagName) ? tagName : 'protected-or-invalid' });
  const ref = await readJson(await fetchImpl(`${baseUrl}/repos/${repo}/git/ref/tags/${encodeURIComponent(tagName)}`, { headers }), diagnostic);
  const refObject = objectField(ref, 'object');
  diagnostic.confirmed();
  diagnostic.at('annotated-tag-validation');
  const refType = objectField(refObject, 'type');
  if (refType !== 'tag') throw new DiagnosticError('annotated-tag-required', { diagnostics: { field: 'tag-object-type', expected: 'tag', observed: ['commit', 'tree', 'blob'].includes(String(refType)) ? refType : 'invalid-or-protected' } });
  const tagObjectSha = requireSha(objectField(refObject, 'sha'), 'tag-sha-invalid');
  diagnostic.confirmed();
  diagnostic.at('tag-object-observation', { tagObjectSha, httpStatus: 'unavailable', requestId: 'unavailable' });
  const tagPayload = await readJson(await fetchImpl(`${baseUrl}/repos/${repo}/git/tags/${tagObjectSha}`, { headers }), diagnostic);
  const sourceObject = objectField(tagPayload, 'object');
  diagnostic.confirmed();
  diagnostic.at('commit-resolution', { tagObjectSha });
  const sourceType = objectField(sourceObject, 'type');
  if (sourceType !== 'commit') throw new DiagnosticError('tag-dereference-to-commit-required', { diagnostics: { field: 'source-object-type', expected: 'commit', observed: ['tag', 'tree', 'blob'].includes(String(sourceType)) ? sourceType : 'invalid-or-protected' } });
  return { tagObjectSha, tagObjectType: 'tag', sourceSha: requireSha(objectField(sourceObject, 'sha'), 'tag-sha-invalid') };
  } catch (error) { throw diagnostic.capture(error); }
};
