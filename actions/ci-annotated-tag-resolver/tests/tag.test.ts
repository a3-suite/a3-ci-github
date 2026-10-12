import { describe, test, expect } from 'vitest';
import { FailureContext } from '../../../runtime/diagnostics/failure.mjs';
import { resolveAnnotatedTag } from '../src/tag.js';

const tagSha = 'a'.repeat(40);
const sourceSha = 'b'.repeat(40);

describe('resolveAnnotatedTag(string,string,string,string,fetch)', () => {
  // target_id: resolveAnnotatedTag(string,string,string,string,fetch)
  test('resolves an annotated tag to its commit', async () => {
    // Arrange
    const calls: string[] = [];
    const fetchImpl = async (url: string): Promise<Response> => {
      calls.push(url);
      const body = calls.length === 1
        ? { object: { type: 'tag', sha: tagSha } }
        : { object: { type: 'commit', sha: sourceSha } };
      return new Response(JSON.stringify(body), { status: 200 });
    };

    // Act
    const result = await resolveAnnotatedTag('owner/repo', 'v1.2.3', 'token', 'https://api.example.test', fetchImpl);

    // Assert
    expect(result).toStrictEqual({ tagObjectSha: tagSha, tagObjectType: 'tag', sourceSha });
    expect(calls[0]).toMatch(/git\/ref\/tags\/v1.2.3$/);
  });

  // target_id: resolveAnnotatedTag(string,string,string,string,fetch)
  test('rejects a lightweight tag', async () => {
    // Arrange
    const fetchImpl = async (): Promise<Response> => new Response(JSON.stringify({ object: { type: 'commit', sha: sourceSha } }), { status: 200 });
    let failure: unknown;

    // Act
    try {
      await resolveAnnotatedTag('owner/repo', 'v1.2.3', 'token', 'https://api.example.test', fetchImpl);
    } catch (error) {
      failure = error;
    }

    // Assert
    expect(String(failure)).toMatch(/annotated-tag-required/);
    const evidence = new FailureContext('ci-annotated-tag-resolver', 'annotated-tag-resolver').evidence(failure);
    expect(evidence.classification.stage).toBe('annotated-tag-validation');
    expect(evidence.comparison).toEqual({ field: 'tag-object-type', expected: 'tag', observed: 'commit' });
  });
  // target_id: resolveAnnotatedTag(string,string,string,string,fetch)
  test('retains safe provider correlation without the response body or token', async () => {
    let failure: unknown;
    try { await resolveAnnotatedTag('owner/repo', 'v1.2.3', 'private-token', 'https://api.example.test', async () => new Response('private-response', { status: 403, headers: { 'x-github-request-id': 'ABCD:1234' } })); } catch (error) { failure = error; }
    const evidence = new FailureContext('ci-annotated-tag-resolver', 'annotated-tag-resolver').evidence(failure);
    expect(evidence.classification).toMatchObject({ stage: 'tag-ref-observation', reason: 'github-api-http-403' });
    expect(evidence.context.inputs).toMatchObject({ repository: 'owner/repo', tag: 'v1.2.3', httpStatus: 403, requestId: 'ABCD:1234' });
    expect(JSON.stringify(evidence)).not.toContain('private-');
  });
});
