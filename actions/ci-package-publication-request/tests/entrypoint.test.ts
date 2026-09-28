import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

// contract_id: contract.ci-package-publication-request.outputs
// integration_id: ci-package-publication-request-contract-entrypoint
test('bundled entrypoint creates and verifies a request', () => {
  // Arrange
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-package-entry-'));
  const output = path.join(root, 'output');
  const request = path.join(root, 'request.json');
  fs.writeFileSync(output, '');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output, INPUT_OPERATION: 'create', 'INPUT_REQUEST-PATH': request, 'INPUT_SOURCE-SHA': 'a'.repeat(40), INPUT_VERSION: '1.2.3', 'INPUT_TARGET-IDENTITY': 'npm:pkg', 'INPUT_LANGUAGE-PROFILE': 'node', INPUT_TOOLCHAIN: '22' } as Record<string, string>;
  const entrypoint = path.resolve(__dirname, '../dist/index.js');

  // Act
  const result = spawnSync(process.execPath, [entrypoint], { env, encoding: 'utf8' });

  // Assert
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(fs.readFileSync(request, 'utf8')).sourceSha, 'a'.repeat(40));

  // Arrange
  fs.writeFileSync(output, '');

  // Act
  const verified = spawnSync(process.execPath, [entrypoint], { env: { ...env, INPUT_OPERATION: 'verify', 'INPUT_EXPECTED-SOURCE-SHA': 'a'.repeat(40) }, encoding: 'utf8' });

  // Assert
  assert.equal(verified.status, 0);
  assert.match(fs.readFileSync(output, 'utf8'), /status<<[^\n]+\nsuccess\n/);
  assert.match(fs.readFileSync(output, 'utf8'), new RegExp(`source-sha<<[^\\n]+\\n${'a'.repeat(40)}\\n`));
  fs.rmSync(root, { recursive: true, force: true });
});

// contract_id: contract.ci-package-publication-request.outputs
// integration_id: ci-package-publication-request-contract-entrypoint
test('bundled entrypoint rejects a source SHA mismatch', () => {
  // Arrange
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-package-entry-rejected-'));
  const output = path.join(root, 'output');
  const request = path.join(root, 'request.json');
  fs.writeFileSync(output, '');
  const entrypoint = path.resolve(__dirname, '../dist/index.js');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output, INPUT_OPERATION: 'create', 'INPUT_REQUEST-PATH': request, 'INPUT_SOURCE-SHA': 'a'.repeat(40), INPUT_VERSION: '1.2.3', 'INPUT_TARGET-IDENTITY': 'npm:pkg', 'INPUT_LANGUAGE-PROFILE': 'node', INPUT_TOOLCHAIN: '22' } as Record<string, string>;
  const created = spawnSync(process.execPath, [entrypoint], { env, encoding: 'utf8' });
  if (created.status !== 0) throw new Error('package request test setup failed');
  fs.writeFileSync(output, '');

  // Act
  const result = spawnSync(process.execPath, [entrypoint], { env: { ...env, INPUT_OPERATION: 'verify', 'INPUT_EXPECTED-SOURCE-SHA': 'b'.repeat(40) }, encoding: 'utf8' });

  // Assert
  assert.notEqual(result.status, 0);
  assert.match(fs.readFileSync(output, 'utf8'), /failed/);
  fs.rmSync(root, { recursive: true, force: true });
});
