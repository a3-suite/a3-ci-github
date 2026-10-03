import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, test } from 'vitest';

import { actionEntrypointArguments } from '../../../tests/support/action-entrypoint';

describe.each(['source', 'dist'] as const)('%s entrypoint', (surface) => {
  const entrypointArgs = actionEntrypointArguments(path.resolve(__dirname, '..'), surface);
const descriptor = (boundary = 'read-only'): string => `schemaVersion: "1"\nkind: ci-adapter-bundle\nid: node-quality\ncontract: quality-scripts\nlanguageProfiles: [node]\nprovider: github\nexecutionBoundary: ${boundary}\nsourceCheckout: fixed-source\ncopyable: true\nowner: ci\nassets: []\nprojectSettings:\n  requiredFiles: []\n  requiredScripts: []\n  requiredEnvironmentPaths: []\ntoolchain:\n  versionEnv: CI_TOOLCHAIN_VERSION\n  verify:\n    command: node\n    args: [--version]\npreparation:\n  - id: prepare\n    command: node\n    args: [-e, "process.exit(0)"]\ncommands:\n  - id: test\n    command: node\n    args: [-e, "process.exit(0)"]\n`;

const runAction = (root: string, content: string, inputs: Record<string, string> = {}) => {
  const descriptor = path.join(root, 'adapter.yml');
  const output = path.join(root, 'output');
  const resultPath = path.join(root, 'result.json');
  fs.writeFileSync(descriptor, content);
  fs.writeFileSync(output, '');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output, 'INPUT_BUNDLE-PATH': descriptor, 'INPUT_SOURCE-ROOT': root, 'INPUT_RESULT-PATH': resultPath, 'INPUT_TOOLCHAIN-VERSION': process.version.slice(1), 'INPUT_REQUIRE-TRUSTED-PROJECT-SCRIPTS': 'false' } as Record<string, string>;
  const result = spawnSync(process.execPath, [...entrypointArgs], { env: { ...env, ...inputs }, encoding: 'utf8' });
  return { result, output, resultPath };
};

// contract_id: contract.ci-quality-adapter.outputs
// integration_id: ci-quality-adapter-contract-entrypoint
test('entrypoint emits status and result path', () => {
  fs.mkdirSync(path.resolve(__dirname, '../../../tmp'), { recursive: true });
  for (const exitCode of [0, 7]) {
    const root = fs.mkdtempSync(path.resolve(__dirname, '../../../tmp/ci-adapter-entry-'));
    try {
      const content = descriptor().replace('id: test\n    command: node\n    args: [-e, "process.exit(0)"]', `id: test\n    command: node\n    args: [-e, "process.exit(${exitCode})"]`);
      const run = runAction(root, content);
      const saved = fs.readFileSync(run.resultPath, 'utf8');
      const payload = JSON.parse(saved);
      const expectedStatus = exitCode === 0 ? 'success' : 'failed';
      assert.equal(run.result.status, exitCode === 0 ? 0 : 1);
      assert.equal(payload.status, expectedStatus);
      assert.equal(payload.results.at(-1).exitCode, exitCode);
      assert.match(fs.readFileSync(run.output, 'utf8'), new RegExp(`status.*${expectedStatus}`, 's'));
      assert.ok(fs.readFileSync(run.output, 'utf8').includes(run.resultPath));
      assert.equal(run.result.stdout.split(saved).length - 1, 1, 'saved result must be logged exactly once');
      if (exitCode !== 0) assert.ok(run.result.stdout.indexOf(saved) < run.result.stdout.indexOf('::error::quality-adapter-failed'));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

// contract_id: contract.ci-quality-adapter.outputs
// integration_id: ci-quality-adapter-standard-selection
test('entrypoint rejects simultaneous standard ID and descriptor before execution', () => {
  const root = fs.mkdtempSync(path.resolve(__dirname, '../../../tmp/ci-adapter-selection-'));
  try {
    const run = runAction(root, descriptor(), { 'INPUT_STANDARD-BUNDLE-ID': 'rust-cargo-quality' });
    assert.notEqual(run.result.status, 0);
    assert.match(`${run.result.stdout}${run.result.stderr}`, /quality-adapter-bundle-selection-invalid/);
    assert.equal(fs.existsSync(run.resultPath), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// contract_id: contract.ci-quality-adapter.outputs
// integration_id: ci-quality-adapter-standard-selection
test('entrypoint rejects an unknown standard ID without a descriptor fallback', () => {
  const root = fs.mkdtempSync(path.resolve(__dirname, '../../../tmp/ci-adapter-selection-'));
  try {
    const run = runAction(root, descriptor(), { 'INPUT_BUNDLE-PATH': '', 'INPUT_STANDARD-BUNDLE-ID': '../unknown' });
    assert.notEqual(run.result.status, 0);
    assert.match(`${run.result.stdout}${run.result.stderr}`, /quality-adapter-standard-bundle-unknown/);
    assert.equal(fs.existsSync(run.resultPath), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// contract_id: contract.ci-quality-adapter.outputs
// integration_id: ci-quality-adapter-standard-selection
test('entrypoint executes the embedded standard without reading a project descriptor', () => {
  const root = fs.mkdtempSync(path.resolve(__dirname, '../../../tmp/ci-adapter-standard-'));
  try {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    const commands = path.join(root, 'commands.jsonl');
    fs.writeFileSync(path.join(bin, 'npm'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(commands)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`, { mode: 0o700 });
    const scripts = Object.fromEntries(['format:check', 'lint', 'typecheck', 'test'].map((name) => [name, 'node --version']));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts }));
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
    const run = runAction(root, 'invalid project descriptor', {
      'INPUT_BUNDLE-PATH': '', 'INPUT_STANDARD-BUNDLE-ID': 'typescript-npm-quality',
      'INPUT_LANGUAGE-PROFILE': 'typescript', 'INPUT_REQUIRE-TRUSTED-PROJECT-SCRIPTS': 'true',
      'INPUT_TRUSTED-PROJECT-ROOT': root, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    });
    assert.equal(run.result.status, 0, run.result.stdout + run.result.stderr);
    const result = JSON.parse(fs.readFileSync(run.resultPath, 'utf8'));
    assert.equal(result.adapter, 'typescript-npm-quality');
    assert.equal(result.status, 'success');
    assert.deepEqual(result.results.map((entry: { id: string }) => entry.id), ['toolchain-verify', 'dependency-restore', 'format', 'lint', 'typecheck', 'test', 'security', 'structure']);
    assert.equal(fs.readFileSync(commands, 'utf8').trim().split('\n').length, 7);
    assert.equal(fs.existsSync(path.join(root, '.ci/adapters')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// integration_id: ci-quality-adapter-entrypoint-regression
test('entrypoint rejects a non-read-only descriptor', () => {
  // Arrange
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-adapter-entry-'));

  // Act
  const run = runAction(root, descriptor('trusted-control'));
  const result = run.result;

  // Assert
  assert.notEqual(result.status, 0);
  assert.match(fs.readFileSync(run.output, 'utf8'), /status.*failed/s);
  assert.equal(fs.existsSync(run.resultPath), false);
  assert.doesNotMatch(result.stdout, /\"schema\": \"ci\.adapter-runner\.v1\"/);
  assert.match(`${result.stdout}${result.stderr}`, /quality-adapter-execution-boundary-invalid/);
  fs.rmSync(root, { recursive: true, force: true });
});

});
