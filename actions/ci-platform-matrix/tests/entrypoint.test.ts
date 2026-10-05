import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, test, expect } from 'vitest';


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
  expect(run.result.status).toBe(0);
  const output = fs.readFileSync(run.outputPath, 'utf8');
  expect(output).toMatch(/^matrix=/);
  expect(output).toMatch(/x86_64-unknown-linux-gnu/);
  expect(output.trim().split('\n').length).toBe(1);
  fs.rmSync(run.tempRoot, { recursive: true, force: true });
});

// contract_id: contract.ci-platform-matrix.outputs
// integration_id: ci-platform-matrix-contract-entrypoint
test('entrypoint fails closed for an unsupported runner', () => {
  // Arrange
  // Act
  const run = runBundled('platforms:\n  - id: linux-x64\n    runner: ubuntu-latest\n    target: x86_64-unknown-linux-gnu\n');
  // Assert
  expect(run.result.status).not.toBe(0);
  expect(fs.readFileSync(run.outputPath, 'utf8')).toBe('');
  expect(`${run.result.stdout}\n${run.result.stderr}`).toMatch(/platform-matrix-platform-0-runner-invalid/);
  fs.rmSync(run.tempRoot, { recursive: true, force: true });
});

// contract_id: contract.ci-platform-matrix.outputs
// integration_id: ci-platform-matrix-contract-entrypoint
test('entrypoint rejects an oversized manifest before parsing', () => {
  // Arrange
  // Act
  const run = runBundled(`platforms:\n${' '.repeat(64 * 1024)}`);
  // Assert
  expect(run.result.status).not.toBe(0);
  expect(fs.readFileSync(run.outputPath, 'utf8')).toBe('');
  expect(run.result.stderr).toMatch(/platform-matrix-manifest-too-large/);
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
    expect(run.result.status, run.result.stderr).toBe(0);
    const outputs = Object.fromEntries(fs.readFileSync(run.outputPath, 'utf8').trim().split('\n')
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    expect(JSON.parse(outputs.matrix).include.map((entry: { id: string }) => entry.id)).toStrictEqual(['linux-x64', 'macos-arm64']);
    expect(JSON.parse(outputs['quality-matrix'])).toStrictEqual({ include: [
      { platform_id: 'macos-arm64', runner: 'macos-14' },
      { platform_id: 'linux-x64', runner: 'ubuntu-24.04' },
    ] });
    expect(outputs['expected-platforms']).toBe('macos-arm64,linux-x64');
  } finally { fs.rmSync(run.tempRoot, { recursive: true, force: true }); }
});

// contract_id: contract.ci-platform-matrix.outputs
// integration_id: ci-platform-matrix-contract-entrypoint
test('entrypoint fails without any outputs for invalid selection', () => {
  const run = runBundled('platforms: [{id: linux-x64, runner: ubuntu-24.04, target: x86_64-unknown-linux-gnu}]', 'platforms: [{id: unknown}]');
  try {
    expect(run.result.status).not.toBe(0);
    expect(run.result.stderr).toMatch(/not declared/);
    expect(fs.readFileSync(run.outputPath, 'utf8')).toBe('');
  } finally { fs.rmSync(run.tempRoot, { recursive: true, force: true }); }
});

});
