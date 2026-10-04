import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test, expect } from 'vitest';

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
  expect(action).toMatch(/^  using: node24$/m);
  expect(action).toMatch(/^  main: dist\/index\.js$/m);
  // Act
  const result = runAction();
  // Assert
  expect(result.status).toBe(0);
  expect(readFileSync(result.outputPath, 'utf8')).toBe(`sha=${SHA}\n`);
});

test('entrypoint rejects a mismatched workflow snapshot', () => {
  // Act
  const result = runAction({ 'INPUT_CALLED-WORKFLOW-SHA': 'cc747e69c63a52dc2a3db336ce269a4df6303ffe' });
  // Assert
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/ci-workflow-identity-sha-mismatch/);
});

test('entrypoint stays idle outside GitHub Actions', () => {
  // Act
  const result = runAction({ GITHUB_ACTIONS: '' });
  // Assert
  expect(result.status).toBe(0);
  expect(readFileSync(result.outputPath, 'utf8')).toBe('');
});

test('entrypoint rejects a missing or unsafe GITHUB_OUTPUT path', () => {
  // Act
  const missing = runAction({ GITHUB_OUTPUT: '' });
  const unsafe = runAction({ GITHUB_OUTPUT: 'safe\nunsafe' });
  // Assert
  expect(missing.status).toBe(1);
  expect(missing.stderr).toMatch(/ci-workflow-identity-output-missing/);
  expect(unsafe.status).toBe(1);
  expect(unsafe.stderr).toMatch(/ci-workflow-identity-output-invalid/);
});

});
