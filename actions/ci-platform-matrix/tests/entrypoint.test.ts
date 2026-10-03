import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, test } from 'vitest';


import { actionEntrypointArguments } from '../../../tests/support/action-entrypoint';

describe.each(['source', 'dist'] as const)('%s entrypoint', (surface) => {
  const entrypointArgs = actionEntrypointArguments(path.resolve(__dirname, '..'), surface);
const root = path.resolve(__dirname, '..');

const runBundled = (manifest: string, selection?: string) => {
  const temporaryParent = path.resolve(root, '../../tmp');
  fs.mkdirSync(temporaryParent, { recursive: true });
  const tempRoot = fs.mkdtempSync(path.join(temporaryParent, 'ci-platform-matrix-'));
  const manifestPath = path.join(tempRoot, 'platforms.yml');
  const outputPath = path.join(tempRoot, 'outputs');
  fs.writeFileSync(manifestPath, manifest, 'utf8');
  fs.writeFileSync(outputPath, '', 'utf8');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: outputPath } as Record<string, string>;
  env['INPUT_MANIFEST-PATH'] = manifestPath;
  delete env['INPUT_SELECTION-PATH'];
  if (selection !== undefined) {
    const selectionPath = path.join(tempRoot, 'selection.yml');
    fs.writeFileSync(selectionPath, selection, 'utf8');
    env['INPUT_SELECTION-PATH'] = selectionPath;
  }
  const result = spawnSync(process.execPath, [...entrypointArgs], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  return { outputPath, result, tempRoot };
};

// contract_id: contract.ci-platform-matrix.outputs
// integration_id: ci-platform-matrix-contract-entrypoint
test('entrypoint emits the validated matrix', () => {
  // Arrange
  // Act
  const run = runBundled('platforms:\n  - id: linux-x64\n    runner: ubuntu-24.04\n    target: x86_64-unknown-linux-gnu\n');
  // Assert
  assert.equal(run.result.status, 0);
  const output = fs.readFileSync(run.outputPath, 'utf8');
  assert.match(output, /^matrix=/);
  assert.match(output, /x86_64-unknown-linux-gnu/);
  assert.equal(output.trim().split('\n').length, 1);
  fs.rmSync(run.tempRoot, { recursive: true, force: true });
});

// contract_id: contract.ci-platform-matrix.outputs
// integration_id: ci-platform-matrix-contract-entrypoint
test('entrypoint fails closed for an unsupported runner', () => {
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
test('entrypoint rejects an oversized manifest before parsing', () => {
  // Arrange
  // Act
  const run = runBundled(`platforms:\n${' '.repeat(64 * 1024)}`);
  // Assert
  assert.notEqual(run.result.status, 0);
  assert.equal(fs.readFileSync(run.outputPath, 'utf8'), '');
  assert.match(run.result.stderr, /platform-matrix-manifest-too-large/);
  fs.rmSync(run.tempRoot, { recursive: true, force: true });
});

// contract_id: contract.ci-platform-matrix.outputs
// integration_id: ci-platform-matrix-contract-entrypoint
test('entrypoint emits ordered quality outputs without changing the manifest matrix', () => {
  const run = runBundled(`platforms:
  - id: linux-x64
    runner: ubuntu-24.04
    target: x86_64-unknown-linux-gnu
  - id: macos-arm64
    runner: macos-14
    target: aarch64-apple-darwin
`, 'platforms: [{id: macos-arm64}, {id: linux-x64}]');
  try {
    assert.equal(run.result.status, 0, run.result.stderr);
    const outputs = Object.fromEntries(fs.readFileSync(run.outputPath, 'utf8').trim().split('\n')
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    assert.deepEqual(JSON.parse(outputs.matrix).include.map((entry: { id: string }) => entry.id), ['linux-x64', 'macos-arm64']);
    assert.deepEqual(JSON.parse(outputs['quality-matrix']), { include: [
      { platform_id: 'macos-arm64', runner: 'macos-14' },
      { platform_id: 'linux-x64', runner: 'ubuntu-24.04' },
    ] });
    assert.equal(outputs['expected-platforms'], 'macos-arm64,linux-x64');
  } finally { fs.rmSync(run.tempRoot, { recursive: true, force: true }); }
});

// contract_id: contract.ci-platform-matrix.outputs
// integration_id: ci-platform-matrix-contract-entrypoint
test('entrypoint fails without any outputs for invalid selection', () => {
  const run = runBundled('platforms: [{id: linux-x64, runner: ubuntu-24.04, target: x86_64-unknown-linux-gnu}]', 'platforms: [{id: unknown}]');
  try {
    assert.notEqual(run.result.status, 0);
    assert.match(run.result.stderr, /not declared/);
    assert.equal(fs.readFileSync(run.outputPath, 'utf8'), '');
  } finally { fs.rmSync(run.tempRoot, { recursive: true, force: true }); }
});

});
