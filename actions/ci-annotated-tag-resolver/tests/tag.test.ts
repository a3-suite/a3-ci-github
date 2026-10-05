import { describe, test, expect } from 'vitest';
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
  });
});
