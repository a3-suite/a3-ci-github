import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, test, expect } from 'vitest';

import { actionEntrypointArguments } from '../../../tests/support/action-entrypoint';

describe.each(['source', 'dist'] as const)('%s entrypoint', (surface) => {
  const entrypointArgs = actionEntrypointArguments(path.resolve(__dirname, '..'), surface);
// contract_id: contract.ci-package-publication-request.outputs
// integration_id: ci-package-publication-request-contract-entrypoint
test('entrypoint creates and verifies a request', () => {
  // Arrange
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-package-entry-'));
  const output = path.join(root, 'output');
  const request = path.join(root, 'request.json');
  fs.writeFileSync(output, '');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output, INPUT_OPERATION: 'create', 'INPUT_REQUEST-PATH': request, 'INPUT_SOURCE-SHA': 'a'.repeat(40), INPUT_VERSION: '1.2.3', 'INPUT_TARGET-IDENTITY': 'npm:pkg', 'INPUT_LANGUAGE-PROFILE': 'node', INPUT_TOOLCHAIN: '22' } as Record<string, string>;
  const entrypoint = entrypointArgs;

  // Act
  const result = spawnSync(process.execPath, [...entrypoint], { env, encoding: 'utf8' });

  // Assert
  expect(result.status).toBe(0);
  expect(JSON.parse(fs.readFileSync(request, 'utf8')).sourceSha).toBe('a'.repeat(40));

  // Arrange
  fs.writeFileSync(output, '');

  // Act
  const verified = spawnSync(process.execPath, [...entrypoint], { env: { ...env, INPUT_OPERATION: 'verify', 'INPUT_EXPECTED-SOURCE-SHA': 'a'.repeat(40) }, encoding: 'utf8' });

  // Assert
  expect(verified.status).toBe(0);
  expect(fs.readFileSync(output, 'utf8')).toMatch(/status<<[^\n]+\nsuccess\n/);
  expect(fs.readFileSync(output, 'utf8')).toMatch(new RegExp(`source-sha<<[^\\n]+\\n${'a'.repeat(40)}\\n`));

  // Arrange
  const saved = fs.readFileSync(request, 'utf8');
  fs.writeFileSync(output, '');
  // Act
  const replay = spawnSync(process.execPath, [...entrypoint], { env: { ...env, INPUT_VERSION: '9.9.9' }, encoding: 'utf8' });
  // Assert
  expect(replay.status).not.toBe(0);
  expect(fs.readFileSync(output, 'utf8')).toMatch(/status<<[^\n]+\nfailed\n/);
  expect(fs.readFileSync(output, 'utf8')).not.toMatch(/(?:source-sha|request-path)<</);
  expect(fs.readFileSync(request, 'utf8')).toBe(saved);
  fs.rmSync(root, { recursive: true, force: true });
});

// contract_id: contract.ci-package-publication-request.outputs
// integration_id: ci-package-publication-request-contract-entrypoint
test('entrypoint rejects a source SHA mismatch', () => {
  // Arrange
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-package-entry-rejected-'));
  const output = path.join(root, 'output');
  const request = path.join(root, 'request.json');
  fs.writeFileSync(output, '');
  const entrypoint = entrypointArgs;
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output, INPUT_OPERATION: 'create', 'INPUT_REQUEST-PATH': request, 'INPUT_SOURCE-SHA': 'a'.repeat(40), INPUT_VERSION: '1.2.3', 'INPUT_TARGET-IDENTITY': 'npm:pkg', 'INPUT_LANGUAGE-PROFILE': 'node', INPUT_TOOLCHAIN: '22' } as Record<string, string>;
  const created = spawnSync(process.execPath, [...entrypoint], { env, encoding: 'utf8' });
  if (created.status !== 0) throw new Error('package request test setup failed');
  fs.writeFileSync(output, '');

  // Act
  const result = spawnSync(process.execPath, [...entrypoint], { env: { ...env, INPUT_OPERATION: 'verify', 'INPUT_EXPECTED-SOURCE-SHA': 'b'.repeat(40) }, encoding: 'utf8' });

  // Assert
  expect(result.status).not.toBe(0);
  expect(fs.readFileSync(output, 'utf8')).toMatch(/failed/);
  fs.rmSync(root, { recursive: true, force: true });
});

});
