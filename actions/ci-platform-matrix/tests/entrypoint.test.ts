import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';


const root = path.resolve(__dirname, '..');

const runBundled = (manifest: string) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-platform-matrix-'));
  const manifestPath = path.join(tempRoot, 'platforms.yml');
  const outputPath = path.join(tempRoot, 'outputs');
  fs.writeFileSync(manifestPath, manifest, 'utf8');
  fs.writeFileSync(outputPath, '', 'utf8');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: outputPath } as Record<string, string>;
  env['INPUT_MANIFEST-PATH'] = manifestPath;
  const result = spawnSync(process.execPath, [path.join(root, 'dist/index.js')], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  return { outputPath, result, tempRoot };
};

// contract_id: contract.ci-platform-matrix.outputs
// integration_id: ci-platform-matrix-contract-entrypoint
test('bundled entrypoint emits the validated matrix', () => {
  // Arrange
  // Act
  const run = runBundled('platforms:\n  - id: linux-x64\n    runner: ubuntu-24.04\n    target: x86_64-unknown-linux-gnu\n');
  // Assert
  assert.equal(run.result.status, 0);
  const output = fs.readFileSync(run.outputPath, 'utf8');
  assert.match(output, /^matrix=/);
  assert.match(output, /x86_64-unknown-linux-gnu/);
  fs.rmSync(run.tempRoot, { recursive: true, force: true });
});

// contract_id: contract.ci-platform-matrix.outputs
// integration_id: ci-platform-matrix-contract-entrypoint
test('bundled entrypoint fails closed for an unsupported runner', () => {
  // Arrange
  // Act
  const run = runBundled('platforms:\n  - id: linux-x64\n    runner: ubuntu-latest\n    target: x86_64-unknown-linux-gnu\n');
  // Assert
  assert.notEqual(run.result.status, 0);
  assert.equal(fs.readFileSync(run.outputPath, 'utf8'), '');
  assert.match(`${run.result.stdout}\n${run.result.stderr}`, /platform-matrix-platform-0-runner-invalid/);
  fs.rmSync(run.tempRoot, { recursive: true, force: true });
});

// contract_id: contract.ci-platform-matrix.outputs
// integration_id: ci-platform-matrix-contract-entrypoint
test('bundled entrypoint rejects an oversized manifest before parsing', () => {
  // Arrange
  // Act
  const run = runBundled(`platforms:\n${' '.repeat(64 * 1024)}`);
  // Assert
  assert.notEqual(run.result.status, 0);
  assert.equal(fs.readFileSync(run.outputPath, 'utf8'), '');
  assert.match(run.result.stderr, /platform-matrix-manifest-too-large/);
  fs.rmSync(run.tempRoot, { recursive: true, force: true });
});
