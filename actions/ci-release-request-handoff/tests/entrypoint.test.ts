import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(__dirname, '..');

// contract_id: contract.ci-release-request-handoff.outputs
// integration_id: ci-release-request-handoff-contract-entrypoint
test('bundled entrypoint writes a tag handoff', () => {
  // Arrange
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-request-entrypoint-'));
  const output = path.join(tempRoot, 'outputs');
  const handoff = path.join(tempRoot, 'handoff');
  fs.writeFileSync(output, '', 'utf8');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output, 'INPUT_OUTPUT-DIRECTORY': handoff, 'INPUT_TAG-SOURCE-SHA': 'a'.repeat(40), 'INPUT_TAG-OBJECT-SHA': 'b'.repeat(40), 'INPUT_GITHUB-REF': 'refs/tags/v1.2.3', 'INPUT_GITHUB-REF-NAME': 'v1.2.3', 'INPUT_REQUEST-RUN-ID': '42', 'INPUT_REQUEST-ACTOR': 'release-operator' } as Record<string, string>;
  // Act
  const result = spawnSync(process.execPath, [path.join(root, 'dist/index.js')], { cwd: root, env, encoding: 'utf8' });
  // Assert
  assert.equal(result.status, 0);
  assert.ok(fs.existsSync(path.join(handoff, 'release-request.json')));
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

// contract_id: contract.ci-release-request-handoff.outputs
// integration_id: ci-release-request-handoff-contract-entrypoint
test('bundled entrypoint rejects a tag ref mismatch', () => {
  // Arrange
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-request-entrypoint-rejected-'));
  const output = path.join(tempRoot, 'outputs');
  const handoff = path.join(tempRoot, 'handoff');
  fs.writeFileSync(output, '', 'utf8');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output, 'INPUT_OUTPUT-DIRECTORY': handoff, 'INPUT_TAG-SOURCE-SHA': 'a'.repeat(40), 'INPUT_TAG-OBJECT-SHA': 'b'.repeat(40), 'INPUT_GITHUB-REF': 'refs/tags/v1.2.4', 'INPUT_GITHUB-REF-NAME': 'v1.2.3', 'INPUT_REQUEST-RUN-ID': '42', 'INPUT_REQUEST-ACTOR': 'release-operator' } as Record<string, string>;

  // Act
  const result = spawnSync(process.execPath, [path.join(root, 'dist/index.js')], { cwd: root, env, encoding: 'utf8' });

  // Assert
  assert.notEqual(result.status, 0);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
