import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'vitest';

import { actionEntrypointArguments } from '../../../tests/support/action-entrypoint';

describe.each(['source', 'dist'] as const)('%s entrypoint', (surface) => {
  const entrypointArgs = actionEntrypointArguments(path.resolve(__dirname, '..'), surface);
const SHA = '3407e7b799c2c1f8726fc88a7b997aa4a23eac1a';
const actionRoot = path.resolve(__dirname, '..');

const runAction = (overrides: Record<string, string> = {}) => {
  const outputPath = path.resolve('tests/tmp/ci-workflow-identity-output.txt');
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, '', 'utf8');
  const result = spawnSync(process.execPath, [...entrypointArgs], {
    encoding: 'utf8',
    env: {
      ...process.env,
      INPUT_REPOSITORY: 'a3-suite/a3-rust-cruiser',
      'INPUT_DEFAULT-BRANCH': 'main',
      'INPUT_EXPECTED-CALLER-WORKFLOW-PATH': '.github/workflows/release-publication-caller.yml',
      'INPUT_EXPECTED-CALLED-WORKFLOW-PATH': '.github/workflows/release-publication.yml',
      'INPUT_CALLER-WORKFLOW-REF': 'a3-suite/a3-rust-cruiser/.github/workflows/release-publication-caller.yml@refs/heads/main',
      'INPUT_CALLER-WORKFLOW-SHA': SHA,
      'INPUT_CALLED-WORKFLOW-REPOSITORY': 'a3-suite/a3-rust-cruiser',
      'INPUT_CALLED-WORKFLOW-FILE-PATH': '.github/workflows/release-publication.yml',
      'INPUT_CALLED-WORKFLOW-REF': 'a3-suite/a3-rust-cruiser/.github/workflows/release-publication.yml@refs/heads/main',
      'INPUT_CALLED-WORKFLOW-SHA': SHA,
      GITHUB_OUTPUT: outputPath,
      GITHUB_ACTIONS: 'true',
      ...overrides,
    },
  });
  return { ...result, outputPath };
};

test('entrypoint exposes the verified workflow snapshot sha', () => {
  // Arrange
  const action = readFileSync(path.join(actionRoot, 'action.yml'), 'utf8');
  assert.match(action, /^  using: node24$/m);
  assert.match(action, /^  main: dist\/index\.js$/m);
  // Act
  const result = runAction();
  // Assert
  assert.equal(result.status, 0);
  assert.equal(readFileSync(result.outputPath, 'utf8'), `sha=${SHA}\n`);
});

test('entrypoint rejects a mismatched workflow snapshot', () => {
  // Act
  const result = runAction({ 'INPUT_CALLED-WORKFLOW-SHA': 'cc747e69c63a52dc2a3db336ce269a4df6303ffe' });
  // Assert
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ci-workflow-identity-sha-mismatch/);
});

test('entrypoint stays idle outside GitHub Actions', () => {
  // Act
  const result = runAction({ GITHUB_ACTIONS: '' });
  // Assert
  assert.equal(result.status, 0);
  assert.equal(readFileSync(result.outputPath, 'utf8'), '');
});

test('entrypoint rejects a missing or unsafe GITHUB_OUTPUT path', () => {
  // Act
  const missing = runAction({ GITHUB_OUTPUT: '' });
  const unsafe = runAction({ GITHUB_OUTPUT: 'safe\nunsafe' });
  // Assert
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /ci-workflow-identity-output-missing/);
  assert.equal(unsafe.status, 1);
  assert.match(unsafe.stderr, /ci-workflow-identity-output-invalid/);
});

});
