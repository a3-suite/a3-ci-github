import { strict as assert } from 'node:assert';
import test from 'node:test';
import { classifyPaths, createDocsOnlyMatcher, detectChangeScope, determineBaseSha, isCommitSha, runGitDiff } from '../src/scope.js';

// integration_id: ci-change-scope-source
test('classifies docs and source changes', () => {
  // Arrange
  const matcher = createDocsOnlyMatcher(['docs/**', 'README.md', '**/*.md']);
  // Act
  const classified = classifyPaths(['README.md', 'docs/guide.md', 'src/app.ts'], matcher);
  const baseSha = determineBaseSha('', 'pull_request', 'base', 'before');
  const scope = detectChangeScope('base', 'head', matcher, () => 'README.md\nsrc/app.ts\n');
  // Assert
  assert.deepEqual(classified, {
    docsFiles: ['README.md', 'docs/guide.md'],
    otherFiles: ['src/app.ts'],
  });
  assert.equal(baseSha, 'base');
  assert.deepEqual(scope, {
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
  assert.equal(result.status, 'unresolved');
  assert.equal(result.runCi, true);
  assert.equal(result.runDocs, true);
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
  assert.equal(valid, true);
  assert.equal(invalid, false);
  assert.match(String(failure), /change-scope-sha-invalid/);
});
