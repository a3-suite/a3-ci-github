import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';


const root = path.resolve(__dirname, '..');
const runBundled = (snapshotPath: string, outputPath: string, sources: unknown, commandOutputPath = outputPath) => {
  fs.writeFileSync(outputPath, '', 'utf8');
  fs.writeFileSync(commandOutputPath, '', 'utf8');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: commandOutputPath } as Record<string, string>;
  env['INPUT_SOURCES-JSON'] = JSON.stringify(sources);
  env['INPUT_SNAPSHOT-PATH'] = snapshotPath;
  env['INPUT_OUTPUT-PATH'] = outputPath;
  return { output: commandOutputPath, result: spawnSync(process.execPath, [path.join(root, 'dist/index.js')], { cwd: root, env, encoding: 'utf8' }) };
};

// contract_id: contract.ci-config-snapshot.outputs
// integration_id: ci-config-snapshot-contract-entrypoint
test('bundled entrypoint writes snapshot and outputs', () => {
  // Arrange
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-config-snapshot-'));
  const snapshot = path.join(tempRoot, 'snapshot.json');
  const output = path.join(tempRoot, 'outputs');
  // Act
  const run = runBundled(snapshot, output, { preset: { MODE: 'release' }, runtime: { MODE: 'dry-run' } });
  // Assert
  assert.equal(run.result.status, 0);
  assert.equal(JSON.parse(fs.readFileSync(snapshot, 'utf8')).values.MODE, 'dry-run');
  assert.match(fs.readFileSync(output, 'utf8'), /config_snapshot_digest=/);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

// integration_id: ci-config-snapshot-entrypoint-regression
test('bundled entrypoint rejects snapshot and output collisions', () => {
  // Arrange
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-config-snapshot-'));
  const snapshot = path.join(tempRoot, 'snapshot.json');
  // Act
  const run = runBundled(snapshot, snapshot, { preset: { MODE: 'release' } });
  // Assert
  assert.notEqual(run.result.status, 0);
  assert.match(fs.readFileSync(run.output, 'utf8'), /status<</);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

// integration_id: ci-config-snapshot-entrypoint-regression
test('bundled entrypoint rejects a snapshot colliding with GITHUB_OUTPUT', () => {
  // Arrange
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-config-snapshot-'));
  const snapshot = path.join(tempRoot, 'snapshot.json');
  const explicitOutput = path.join(tempRoot, 'explicit-output');
  // Act
  const run = runBundled(snapshot, explicitOutput, { preset: { MODE: 'release' } }, snapshot);
  // Assert
  assert.notEqual(run.result.status, 0);
  assert.match(fs.readFileSync(run.output, 'utf8'), /failed/);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
