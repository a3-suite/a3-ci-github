import { describe, expect, test } from 'vitest';
import { classifyPaths, createDocsOnlyMatcher, detectChangeScope, determineBaseSha, isCommitSha, runGitDiff } from '../src/scope.js';

describe('change scope', () => {
  describe('ci-change-scope-source', () => {
    // integration_id: ci-change-scope-source
    test('classifies docs and source changes', () => {
      // Arrange
      const matcher = createDocsOnlyMatcher(['docs/**', 'README.md', '**/*.md']);
      // Act
      const classified = classifyPaths(['README.md', 'docs/guide.md', 'src/app.ts'], matcher);
      const baseSha = determineBaseSha('', 'pull_request', 'base', 'before');
      const scope = detectChangeScope('base', 'head', matcher, () => 'README.md\0src/app.ts\0');
      // Assert
      expect(classified).toStrictEqual({
        docsFiles: ['README.md', 'docs/guide.md'],
        otherFiles: ['src/app.ts'],
      });
      expect(baseSha).toBe('base');
      expect(scope).toStrictEqual({
        runCi: true,
        runDocs: true,
        files: ['README.md', 'src/app.ts'],
        docsFiles: ['README.md'],
        otherFiles: ['src/app.ts'],
        status: 'success',
      });
    });

    // integration_id: ci-change-scope-source
    test('fails open with unresolved status when the range is unavailable', () => {
      // Arrange
      const matcher = createDocsOnlyMatcher(['**/*.md']);
      // Act
      const result = detectChangeScope('', '', matcher, () => '');
      // Assert
      expect(result.status).toBe('unresolved');
      expect(result.runCi).toBe(true);
      expect(result.runDocs).toBe(true);
    });

    // integration_id: ci-change-scope-source
    test('accepts only full commit SHAs before invoking git', () => {
      // Arrange
      let failure: unknown;
      // Act
      const valid = isCommitSha('a'.repeat(40));
      const invalid = isCommitSha('--relative=src');
      try { runGitDiff('--relative=src', 'b'.repeat(40)); } catch (error) { failure = error; }
      // Assert
      expect(valid).toBe(true);
      expect(invalid).toBe(false);
      expect(String(failure)).toMatch(/change-scope-sha-invalid/);
    });
  });
});
