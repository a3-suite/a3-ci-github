import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(__dirname, '..');

// contract_id: contract.ci-release-notes-input-resolution.outputs
// integration_id: ci-release-notes-input-resolution-contract-entrypoint
test('bundled entrypoint resolves an external tag handoff', () => {
  // Arrange
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-notes-entrypoint-'));
  const source = path.join(tempRoot, 'source');
  const output = path.join(tempRoot, 'output');
  const outputFile = path.join(tempRoot, 'outputs');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'release-notes.json'), '{}');
  fs.writeFileSync(path.join(source, 'release-notes-approval.json'), '{}');
  fs.writeFileSync(outputFile, '', 'utf8');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: outputFile, 'INPUT_INPUT-HANDOFF-DIRECTORY': source, 'INPUT_OUTPUT-DIRECTORY': output } as Record<string, string>;
  // Act
  const result = spawnSync(process.execPath, [path.join(root, 'dist/index.js')], { cwd: root, env, encoding: 'utf8' });
  // Assert
  assert.equal(result.status, 0);
  assert.ok(fs.existsSync(path.join(output, 'release-notes.json')));
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

// contract_id: contract.ci-release-notes-input-resolution.outputs
// integration_id: ci-release-notes-input-resolution-contract-entrypoint
test('bundled entrypoint rejects an existing normalized handoff', () => {
  // Arrange
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-notes-entrypoint-rejected-'));
  const source = path.join(tempRoot, 'source');
  const output = path.join(tempRoot, 'output');
  const outputFile = path.join(tempRoot, 'outputs');
  fs.mkdirSync(source);
  fs.mkdirSync(output);
  fs.writeFileSync(path.join(source, 'release-notes.json'), '{}');
  fs.writeFileSync(path.join(source, 'release-notes-approval.json'), '{}');
  fs.writeFileSync(path.join(output, 'release-notes.json'), 'existing');
  fs.writeFileSync(outputFile, '', 'utf8');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: outputFile, 'INPUT_INPUT-HANDOFF-DIRECTORY': source, 'INPUT_OUTPUT-DIRECTORY': output } as Record<string, string>;

  // Act
  const result = spawnSync(process.execPath, [path.join(root, 'dist/index.js')], { cwd: root, env, encoding: 'utf8' });

  // Assert
  assert.notEqual(result.status, 0);
  assert.match(fs.readFileSync(outputFile, 'utf8'), /failed/);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
