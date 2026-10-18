import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, test, expect } from 'vitest';

import { qualityAdapterDescriptor } from '../../../runtime/repository/action-reference-fixtures.mjs';

import { actionEntrypointArguments } from '../../../tests/support/action-entrypoint';

describe.each(['source', 'dist'] as const)('%s entrypoint', (surface) => {
  const entrypointArgs = actionEntrypointArguments(path.resolve(__dirname, '..'), surface);
const descriptor = qualityAdapterDescriptor;

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
// flow_id: ci-quality-adapter-contract-entrypoint
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
      expect(run.result.status).toBe(exitCode === 0 ? 0 : 1);
      expect(payload.status).toBe(expectedStatus);
      expect(payload.results.at(-1).exitCode).toBe(exitCode);
      expect(fs.readFileSync(run.output, 'utf8')).toMatch(new RegExp(`status.*${expectedStatus}`, 's'));
      expect(fs.readFileSync(run.output, 'utf8').includes(run.resultPath)).toBeTruthy();
      expect(run.result.stdout.split(saved).length - 1, 'saved result must be logged exactly once').toBe(1);
      const timings = run.result.stderr.split('\n').filter(line => line.startsWith('ci-quality-command-timing:')).map(line => JSON.parse(line.slice('ci-quality-command-timing:'.length)));
      expect(timings.map(({ phase }) => phase)).toStrictEqual(['toolchain', 'preparation', 'command']);
      expect(timings.map(({ id, status, exit_code }) => ({ id, status, exitCode: exit_code }))).toStrictEqual(payload.results.map(({ id, status, exitCode }: { id: string; status: string; exitCode: number | null }) => ({ id, status, exitCode })));
      for (const timing of timings) {
        expect(Object.keys(timing).sort()).toStrictEqual(['elapsed_ms', 'exit_code', 'id', 'phase', 'status']);
        expect(Number.isFinite(timing.elapsed_ms)).toBe(true);
        expect(timing.elapsed_ms).toBeGreaterThanOrEqual(0);
      }
      expect(run.result.stdout).not.toContain('ci-quality-command-timing:');
      expect(saved).not.toContain('elapsed_ms');
      if (exitCode !== 0) expect(run.result.stdout.indexOf(saved) < run.result.stdout.indexOf('::error::quality-adapter-failed')).toBeTruthy();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

// flow_id: ci-quality-adapter-entrypoint-regression
test('command timings preserve toolchain rejection and preparation stopping', (t) => {
  fs.mkdirSync(path.resolve(__dirname, '../../../tmp'), { recursive: true });
  const root = fs.mkdtempSync(path.resolve(__dirname, '../../../tmp/ci-adapter-timing-'));
  t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [content, inputs, phases, status, exitCode] of [
    [descriptor(), { 'INPUT_TOOLCHAIN-VERSION': '0.0.0' }, ['toolchain'], 'failed', 0],
    [descriptor().replace('command: node', 'command: nonexistent-quality-timing-executable'), {}, ['toolchain'], '判定不能', null],
    [descriptor().replace('process.exit(0)', 'process.exit(9)'), {}, ['toolchain', 'preparation'], 'failed', 9],
  ] as const) {
    const run = runAction(root, content, inputs);
    const timings = run.result.stderr.split('\n').filter(line => line.startsWith('ci-quality-command-timing:')).map(line => JSON.parse(line.slice('ci-quality-command-timing:'.length)));
    expect(run.result.status).toBe(1);
    expect(timings.map(({ phase }) => phase)).toStrictEqual(phases);
    expect(timings.at(-1)).toMatchObject({ status, exit_code: exitCode });
    expect(JSON.parse(fs.readFileSync(run.resultPath, 'utf8')).results).toHaveLength(phases.length);
  }
});

// contract_id: contract.ci-quality-adapter.outputs
// flow_id: ci-quality-adapter-standard-selection
test('entrypoint rejects a standard bundle supplied through a local descriptor', () => {
  // Arrange
  const root = fs.mkdtempSync(path.resolve(__dirname, '../../../tmp/ci-adapter-local-standard-'));
  try {
    for (const id of ['rust-cargo-quality', 'python-uv-quality', 'typescript-npm-quality']) {
      // Act
      const run = runAction(root, descriptor().replace('id: node-quality', `id: ${id}`));
      // Assert
      expect(run.result.status).not.toBe(0);
      expect(`${run.result.stdout}${run.result.stderr}`).toMatch(/quality-adapter-standard-id-requires-action-bundle/);
      expect(fs.existsSync(run.resultPath)).toBe(false);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// contract_id: contract.ci-quality-adapter.outputs
// flow_id: ci-quality-adapter-standard-selection
test('entrypoint rejects simultaneous standard ID and descriptor before execution', () => {
  const root = fs.mkdtempSync(path.resolve(__dirname, '../../../tmp/ci-adapter-selection-'));
  try {
    const run = runAction(root, descriptor(), { 'INPUT_STANDARD-BUNDLE-ID': 'rust-cargo-quality' });
    expect(run.result.status).not.toBe(0);
    expect(`${run.result.stdout}${run.result.stderr}`).toMatch(/quality-adapter-bundle-selection-invalid/);
    expect(fs.existsSync(run.resultPath)).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// contract_id: contract.ci-quality-adapter.outputs
// flow_id: ci-quality-adapter-standard-selection
test('entrypoint rejects an unknown standard ID without a descriptor fallback', () => {
  const root = fs.mkdtempSync(path.resolve(__dirname, '../../../tmp/ci-adapter-selection-'));
  try {
    const run = runAction(root, descriptor(), { 'INPUT_BUNDLE-PATH': '', 'INPUT_STANDARD-BUNDLE-ID': '../unknown' });
    expect(run.result.status).not.toBe(0);
    expect(`${run.result.stdout}${run.result.stderr}`).toMatch(/quality-adapter-standard-bundle-unknown/);
    expect(fs.existsSync(run.resultPath)).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// contract_id: contract.ci-quality-adapter.outputs
// flow_id: ci-quality-adapter-standard-selection
test('entrypoint executes the embedded standard without reading a project descriptor', () => {
  const root = fs.mkdtempSync(path.resolve(__dirname, '../../../tmp/ci-adapter-standard-'));
  try {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    const commands = path.join(root, 'commands.jsonl');
    fs.writeFileSync(path.join(bin, 'npm'), `#!${process.execPath}\nprocess.getBuiltinModule('node:fs').appendFileSync(${JSON.stringify(commands)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`, { mode: 0o700 });
    const scripts = Object.fromEntries(['format:check', 'lint', 'typecheck', 'test'].map((name) => [name, 'node --version']));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts }));
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
    const run = runAction(root, 'invalid project descriptor', {
      'INPUT_BUNDLE-PATH': '', 'INPUT_STANDARD-BUNDLE-ID': 'typescript-npm-quality',
      'INPUT_LANGUAGE-PROFILE': 'typescript', 'INPUT_REQUIRE-TRUSTED-PROJECT-SCRIPTS': 'true',
      'INPUT_TRUSTED-PROJECT-ROOT': root, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    });
    expect(run.result.status, run.result.stdout + run.result.stderr).toBe(0);
    const result = JSON.parse(fs.readFileSync(run.resultPath, 'utf8'));
    expect(result.adapter).toBe('typescript-npm-quality');
    expect(result.status).toBe('success');
    expect(result.results.map((entry: { id: string }) => entry.id)).toStrictEqual(['toolchain-verify', 'dependency-restore', 'format', 'lint', 'typecheck', 'test', 'security', 'structure']);
    expect(fs.readFileSync(commands, 'utf8').trim().split('\n').length).toBe(7);
    expect(fs.existsSync(path.join(root, '.ci/adapters'))).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// contract_id: contract.ci-quality-adapter.outputs
// flow_id: ci-quality-adapter-execution-scope
test('standard Rust scope preserves native checks and rejects unsupported scopes before commands', (t) => {
  // Arrange
  const root = fs.mkdtempSync(path.resolve(__dirname, '../../../tmp/ci-adapter-scope-'));
  t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(root, 'commands.jsonl');
  fs.writeFileSync(path.join(root, 'Cargo.toml'), '[package]\nname="fixture"\nversion="0.1.0"\n');
  fs.writeFileSync(path.join(root, 'Cargo.lock'), '');
  fs.writeFileSync(path.join(bin, 'rustc'), `#!${process.execPath}\nconsole.log('rustc 1.80.0');\n`, { mode: 0o700 });
  fs.writeFileSync(path.join(bin, 'cargo'), `#!${process.execPath}\nprocess.getBuiltinModule('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2))+'\\n');\n`, { mode: 0o700 });
  const inputs = { 'INPUT_BUNDLE-PATH': '', 'INPUT_STANDARD-BUNDLE-ID': 'rust-cargo-quality', 'INPUT_TOOLCHAIN-VERSION': '1.80.0', 'INPUT_LANGUAGE-PROFILE': 'rust',
    CI_CARGO_MANIFEST_PATH: 'Cargo.toml', CI_CARGO_LOCK_PATH: 'Cargo.lock', PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  // Act
  for (const scope of ['', 'all', 'native']) {
    fs.writeFileSync(log, '');
    const run = runAction(root, 'invalid ignored descriptor', { ...inputs, 'INPUT_EXECUTION-SCOPE': scope });
    const saved = JSON.parse(fs.readFileSync(run.resultPath, 'utf8'));
    // Assert
    expect(run.result.status, run.result.stdout + run.result.stderr).toBe(0);
    expect(saved.results.map((entry: { id: string }) => entry.id)).toStrictEqual(scope === 'native'
      ? ['toolchain-verify', 'dependency-restore', 'lint', 'test', 'structure']
      : ['toolchain-verify', 'dependency-restore', 'format', 'lint', 'test', 'security', 'structure']);
    expect(fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)[0])).toStrictEqual(scope === 'native'
      ? ['fetch', 'clippy', 'test', 'metadata'] : ['fetch', 'fmt', 'clippy', 'test', 'audit', 'metadata']);
  }
  for (const rejected of [
    { 'INPUT_EXECUTION-SCOPE': 'unknown' },
    { 'INPUT_EXECUTION-SCOPE': 'native', 'INPUT_STANDARD-BUNDLE-ID': 'python-uv-quality' },
    { 'INPUT_EXECUTION-SCOPE': 'native', 'INPUT_STANDARD-BUNDLE-ID': 'typescript-npm-quality' },
    { 'INPUT_EXECUTION-SCOPE': 'native', 'INPUT_STANDARD-BUNDLE-ID': '', 'INPUT_BUNDLE-PATH': path.join(root, 'adapter.yml') },
  ]) {
    fs.writeFileSync(log, '');
    fs.rmSync(path.join(root, 'result.json'), { force: true });
    const run = runAction(root, descriptor(), { ...inputs, ...rejected });
    expect(run.result.status).not.toBe(0);
    expect(run.result.stderr + run.result.stdout).toMatch(/quality-adapter-(execution-scope-invalid|native-scope-unsupported)/);
    expect(fs.readFileSync(log, 'utf8')).toBe('');
    expect(fs.existsSync(run.resultPath)).toBe(false);
  }
});

// contract_id: contract.ci-quality-adapter.outputs
// flow_id: ci-quality-adapter-execution-scope
test('native Rust scope retains toolchain preparation and native command failure', (t) => {
  // Arrange
  const root = fs.mkdtempSync(path.resolve(__dirname, '../../../tmp/ci-adapter-native-failure-'));
  t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(root, 'Cargo.toml'), ''); fs.writeFileSync(path.join(root, 'Cargo.lock'), '');
  fs.writeFileSync(path.join(bin, 'rustc'), `#!${process.execPath}\nconsole.log('rustc '+(process.env.FAIL_COMMAND==='rustc'?'0.0.0':'1.80.0'));\n`, { mode: 0o700 });
  fs.writeFileSync(path.join(bin, 'cargo'), `#!${process.execPath}\nprocess.exit(process.argv[2]===process.env.FAIL_COMMAND?7:0);\n`, { mode: 0o700 });
  // Act
  for (const failure of ['rustc', 'fetch', 'clippy', 'test', 'metadata'] as const) {
    const run = runAction(root, 'ignored', { 'INPUT_BUNDLE-PATH': '', 'INPUT_STANDARD-BUNDLE-ID': 'rust-cargo-quality', 'INPUT_EXECUTION-SCOPE': 'native',
      'INPUT_TOOLCHAIN-VERSION': '1.80.0', FAIL_COMMAND: failure, CI_CARGO_MANIFEST_PATH: 'Cargo.toml', CI_CARGO_LOCK_PATH: 'Cargo.lock', PATH: `${bin}${path.delimiter}${process.env.PATH}` });
    const payload = JSON.parse(fs.readFileSync(run.resultPath, 'utf8'));
    // Assert
    expect(run.result.status).toBe(1);
    expect(payload.status).toBe('failed');
    expect(run.result.stderr).toContain('ci-failure-diagnostic:');
    expect(payload.results).toHaveLength(failure === 'rustc' ? 1 : failure === 'fetch' ? 2 : 5);
    const nativeIds = ['toolchain-verify', 'dependency-restore', 'lint', 'test', 'structure'];
    expect(payload.results.map((entry: { id: string }) => entry.id)).toStrictEqual(nativeIds.slice(0, failure === 'rustc' ? 1 : failure === 'fetch' ? 2 : 5));
    const failedId = { rustc: 'toolchain-verify', fetch: 'dependency-restore', clippy: 'lint', test: 'test', metadata: 'structure' }[failure];
    expect(payload.results.map((entry: { id: string; status: string }) => ({ id: entry.id, status: entry.status }))).toStrictEqual(
      nativeIds.slice(0, failure === 'rustc' ? 1 : failure === 'fetch' ? 2 : 5).map(id => ({ id, status: id === failedId ? 'failed' : 'success' })),
    );
    expect(payload.results.some((entry: { status: string }) => entry.status === 'failed')).toBe(true);
  }
});

// flow_id: ci-quality-adapter-entrypoint-regression
test('entrypoint rejects a non-read-only descriptor', () => {
  // Arrange
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-adapter-entry-'));

  // Act
  const run = runAction(root, descriptor('trusted-control'));
  const result = run.result;

  // Assert
  expect(result.status).not.toBe(0);
  expect(fs.readFileSync(run.output, 'utf8')).toMatch(/status.*failed/s);
  expect(fs.existsSync(run.resultPath)).toBe(false);
  expect(result.stdout).not.toMatch(/\"schema\": \"ci\.adapter-runner\.v1\"/);
  expect(`${result.stdout}${result.stderr}`).toMatch(/quality-adapter-execution-boundary-invalid/);
  fs.rmSync(root, { recursive: true, force: true });
});

// contract_id: contract.ci-quality-adapter.outputs
// flow_id: ci-quality-adapter-contract-entrypoint
test('entrypoint keeps unsafe child output out of logs and the public result', (t) => {
  fs.mkdirSync(path.resolve(__dirname, '../../../tmp'), { recursive: true });
  const root = fs.mkdtempSync(path.resolve(__dirname, '../../../tmp/ci-adapter-private-'));
  t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const content = descriptor().replace('id: prepare', 'id: private/id-sentinel').replace('process.exit(0)', "process.stderr.write('private-child-sentinel'); process.exit(7)");
  const run = runAction(root, content);
  expect(run.result.status).toBe(1);
  const saved = fs.readFileSync(run.resultPath, 'utf8');
  const payload = JSON.parse(saved);
  expect(payload.status).toBe('failed');
  expect(payload.results.at(-1).exitCode).toBe(7);
  expect(payload.results.at(-1).stderr).toBe('protected-child-output');
  expect(saved + run.result.stdout + run.result.stderr).not.toContain('private-child-sentinel');
  expect(saved + run.result.stdout + run.result.stderr).not.toContain('private/id-sentinel');
  expect(run.result.stderr).toContain('"id":"protected-or-invalid"');
});

});
