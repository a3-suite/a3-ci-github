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

const fileNames = (directory: string): string[] => fs.readdirSync(directory, { recursive: true, encoding: 'utf8' }).sort();

// `filesBefore` and `filesAfter` are the file names under the root around the invocation. The failure result output (`output`) exists before the invocation, so it does not change the names.
const runAction = (root: string, content: string, inputs: Record<string, string> = {}, { outputWritable = true, expectCustomDescriptorRead = false } = {}) => {
  const descriptor = path.join(root, 'adapter.yml');
  const output = path.join(root, 'output');
  const resultPath = path.join(root, 'result.json');
  fs.writeFileSync(descriptor, content);
  fs.writeFileSync(output, '');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: outputWritable ? output : root, 'INPUT_BUNDLE-PATH': descriptor, 'INPUT_SOURCE-ROOT': root, 'INPUT_RESULT-PATH': resultPath, 'INPUT_TOOLCHAIN-VERSION': process.version.slice(1), 'INPUT_REQUIRE-TRUSTED-PROJECT-SCRIPTS': 'false' } as Record<string, string>;
  const filesBefore = fileNames(root);
  // Observe the descriptor loader's synchronous reads, including reads whose contents are discarded.
  const standardBundleSelected = Boolean(inputs['INPUT_STANDARD-BUNDLE-ID']) && inputs['INPUT_BUNDLE-PATH'] === '';
  const traceDescriptorReads = standardBundleSelected || expectCustomDescriptorRead;
  const readMarker = 'consumer-descriptor-read';
  const preload = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    const read = fs.readFileSync;
    fs.readFileSync = function (file, ...options) {
      if (typeof file === 'string') {
        const relative = path.relative(${JSON.stringify(root)}, path.resolve(file));
        if (relative === 'adapter.yml' || relative.startsWith(path.join('.ci', 'adapters') + path.sep)) {
          process.stderr.write(${JSON.stringify(`${readMarker}\n`)});
        }
      }
      return read.call(this, file, ...options);
    };
    syncBuiltinESMExports();
  `;
  const traceArgs = traceDescriptorReads ? ['--import', `data:text/javascript,${encodeURIComponent(preload)}`] : [];
  const result = spawnSync(process.execPath, [...traceArgs, ...entrypointArgs], { env: { ...env, ...inputs }, encoding: 'utf8' });
  if (traceDescriptorReads) expect(result.stderr.split('\n').includes(readMarker)).toBe(expectCustomDescriptorRead);
  return { result, output, resultPath, filesBefore, filesAfter: fileNames(root) };
};

type ResultEntry = { id: string; status: string; reason?: string };

// Only the not-run of an unconfigured optional command is excluded; the status is success exactly when every other result succeeded.
const statusMatchesResults = (payload: { status: string; results: ResultEntry[] }): boolean => {
  const remaining = payload.results.filter((entry) => !(entry.status === 'not-run' && entry.reason === 'not-configured'));
  return (payload.status === 'success') === remaining.every((entry) => entry.status === 'success');
};

const expectPublishedResult = (run: ReturnType<typeof runAction>, status: string): void => {
  const output = fs.readFileSync(run.output, 'utf8');
  expect(output.match(/^status<<([^\r\n]+)\r?\n([^\r\n]+)\r?\n\1$/m)?.[2]).toBe(status);
  expect(output.match(/^result-path<<([^\r\n]+)\r?\n([^\r\n]+)\r?\n\1$/m)?.[2]).toBe(run.resultPath);
};

// contract_id: contract.ci-quality-adapter.outputs
// flow_id: ci-quality-adapter-contract-entrypoint
test('entrypoint emits status and result path', () => {
  fs.mkdirSync(path.resolve(__dirname, '../../../tmp'), { recursive: true });
  for (const exitCode of [0, 7]) {
    const root = fs.mkdtempSync(path.resolve(__dirname, '../../../tmp/ci-adapter-entry-'));
    try {
      const content = descriptor().replace('id: test\n    command: node\n    args: [-e, "process.exit(0)"]', `id: test\n    command: node\n    args: [-e, "process.exit(${exitCode})"]`);
      const run = runAction(root, content, {}, { expectCustomDescriptorRead: true });
      const saved = fs.readFileSync(run.resultPath, 'utf8');
      const payload = JSON.parse(saved);
      const expectedStatus = exitCode === 0 ? 'success' : 'failed';
      expect(run.result.status).toBe(exitCode === 0 ? 0 : 1);
      expect(payload.status).toBe(expectedStatus);
      expect(statusMatchesResults(payload)).toBe(true);
      expect(payload.results.at(-1).exitCode).toBe(exitCode);
      expectPublishedResult(run, expectedStatus);
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

test('entrypoint reports failure when the result JSON cannot be saved', (t) => {
  const root = fs.mkdtempSync(path.resolve(__dirname, '../../../tmp/ci-adapter-result-write-'));
  t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = runAction(root, descriptor(), { 'INPUT_RESULT-PATH': root });
  expect(run.result.status).toBe(1);
  expect(run.result.stderr).toMatch(/^ci-failure-diagnostic:.*"stage":"result-write"/m);
  expect(fs.readFileSync(run.output, 'utf8')).not.toMatch(/^result-path<</m);
});

// evidence_role: supplemental
// Guards the predicate that the mapped tests apply to the real Action results.
test('status consistency rejects success reported over a not-run command other than an unconfigured optional command', () => {
  // Arrange
  const unconfiguredPolicy = { id: 'dependency-policy', status: 'not-run', reason: 'not-configured' };
  const unconfiguredLint = { id: 'lint', status: 'not-run', reason: 'not-configured' };
  const skippedLint = { id: 'lint', status: 'not-run', reason: 'skipped' };
  const passed = [{ id: 'test', status: 'success' }];
  // Act
  const outcomes = [
    statusMatchesResults({ status: 'success', results: [...passed, unconfiguredPolicy] }),
    statusMatchesResults({ status: 'success', results: [unconfiguredLint, ...passed] }),
    statusMatchesResults({ status: 'success', results: [skippedLint, ...passed] }),
    statusMatchesResults({ status: 'success', results: [{ ...unconfiguredPolicy, status: 'success' }, { id: 'test', status: '判定不能' }] }),
    statusMatchesResults({ status: 'failed', results: [skippedLint, ...passed] }),
  ];
  // Assert
  expect(outcomes).toStrictEqual([true, true, false, false, true]);
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
test('entrypoint accepts the requested version as a standalone token', (t) => {
  fs.mkdirSync(path.resolve(__dirname, '../../../tmp'), { recursive: true });
  const root = fs.mkdtempSync(path.resolve(__dirname, '../../../tmp/ci-adapter-version-token-'));
  t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [stream, token] of [['log', '9.9.9'], ['log', 'v9.9.9'], ['error', 'V9.9.9']]) {
    const content = descriptor().replace('args: [--version]', `args: [-e, "console.${stream}('tool ${token} (fixture)')"]`);
    const run = runAction(root, content, { 'INPUT_TOOLCHAIN-VERSION': '9.9.9' });
    expect(run.result.status, run.result.stderr).toBe(0);
    const payload = JSON.parse(fs.readFileSync(run.resultPath, 'utf8'));
    expect(payload.status).toBe('success');
    expect(payload.results[0]).toMatchObject({ id: 'toolchain-verify', status: 'success' });
    expect(payload.results[1]).toMatchObject({ id: 'prepare', status: 'success' });
  }
});

// contract_id: contract.ci-quality-adapter.outputs
test('entrypoint publishes the toolchain version mismatch code without child output', (t) => {
  fs.mkdirSync(path.resolve(__dirname, '../../../tmp'), { recursive: true });
  const root = fs.mkdtempSync(path.resolve(__dirname, '../../../tmp/ci-adapter-mismatch-'));
  t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [childOutput, childExit] of [['toolchain-child-output-sentinel', 0], ['9.9.9-rc1', 0], ['v9.9.9', 7]] as const) {
    const content = descriptor().replace('args: [--version]', `args: [-e, "console.log('${childOutput}');process.exit(${childExit})"]`);
    const run = runAction(root, content, { 'INPUT_TOOLCHAIN-VERSION': '9.9.9' });
    const diagnostics = run.result.stderr.split('\n')
      .filter(line => line.startsWith('ci-failure-diagnostic:'))
      .map(line => JSON.parse(line.slice('ci-failure-diagnostic:'.length)));

    expect(run.result.status, childOutput).toBe(1);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      classification: expect.objectContaining({ reason: 'quality-adapter-toolchain-version-mismatch' }),
    }));
    const savedResult = fs.readFileSync(run.resultPath, 'utf8');
    expect(Object.keys(JSON.parse(savedResult)).sort()).toStrictEqual([
      'adapter', 'contract', 'languageProfiles', 'results', 'schema', 'status',
    ]);
    expect(JSON.parse(savedResult).results.map((entry: ResultEntry) => entry.id)).toEqual(['toolchain-verify']);
    for (const output of [run.result.stdout, run.result.stderr, savedResult, fs.readFileSync(run.output, 'utf8')]) {
      expect(output).not.toContain(childOutput);
    }
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
      expect(run.result.status, run.result.stderr).toBe(1);
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
    expect(run.result.status, run.result.stderr).toBe(1);
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
    expect(run.result.status, run.result.stderr).toBe(1);
    expect(`${run.result.stdout}${run.result.stderr}`).toMatch(/quality-adapter-standard-bundle-unknown/);
    expect(fs.existsSync(run.resultPath)).toBe(false);
    expect(run.filesAfter).toEqual(run.filesBefore);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// contract_id: contract.ci-quality-adapter.outputs
// flow_id: ci-quality-adapter-standard-selection
test('entrypoint executes the embedded Python standard and emits its status', (t) => {
  // Arrange
  fs.mkdirSync(path.resolve(__dirname, '../../../tmp'), { recursive: true });
  const root = fs.mkdtempSync(path.resolve(__dirname, '../../../tmp/ci-adapter-python-'));
  t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const commands = path.join(root, 'commands.jsonl');
  fs.writeFileSync(path.join(bin, 'python'), `#!${process.execPath}\nconsole.log('Python 3.12.1');\n`, { mode: 0o700 });
  fs.writeFileSync(path.join(bin, 'uv'), `#!${process.execPath}\nprocess.getBuiltinModule('node:fs').appendFileSync(${JSON.stringify(commands)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`, { mode: 0o700 });
  fs.writeFileSync(path.join(root, 'pyproject.toml'), '[project]\nname = "fixture"\n');
  fs.writeFileSync(path.join(root, 'uv.lock'), '');
  // Act
  const run = runAction(root, 'invalid project descriptor', {
    'INPUT_BUNDLE-PATH': '', 'INPUT_STANDARD-BUNDLE-ID': 'python-uv-quality', 'INPUT_LANGUAGE-PROFILE': 'python',
    'INPUT_TOOLCHAIN-VERSION': '3.12.1', 'INPUT_REQUIRE-TRUSTED-PROJECT-SCRIPTS': 'true', 'INPUT_TRUSTED-PROJECT-ROOT': root,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  });
  // Assert
  expect(run.result.status, run.result.stdout + run.result.stderr).toBe(0);
  const result = JSON.parse(fs.readFileSync(run.resultPath, 'utf8'));
  expect(result).toMatchObject({ adapter: 'python-uv-quality', status: 'success' });
  expect(statusMatchesResults(result)).toBe(true);
  expect(result.results.map((entry: { id: string }) => entry.id)).toStrictEqual(['toolchain-verify', 'dependency-restore', 'format', 'lint', 'test', 'security', 'structure']);
  expect(fs.readFileSync(commands, 'utf8').trim().split('\n').map((line) => JSON.parse(line)[0])).toStrictEqual(['sync', 'run', 'run', 'run', 'run', 'run']);
  expect(fs.readFileSync(run.output, 'utf8')).toMatch(/status.*success/s);
});

const executeEmbeddedStandard = (mode: 'result' | 'descriptor-directory'): void => {
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
    expect(statusMatchesResults(result)).toBe(true);
    expectPublishedResult(run, result.status);
    expect(result.results.map((entry: { id: string }) => entry.id)).toStrictEqual(['toolchain-verify', 'dependency-restore', 'format', 'lint', 'typecheck', 'test', 'security', 'structure']);
    expect(fs.readFileSync(commands, 'utf8').trim().split('\n').length).toBe(7);
    if (mode === 'descriptor-directory') expect(fs.existsSync(path.join(root, '.ci/adapters'))).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
};

// contract_id: contract.ci-quality-adapter.outputs
// flow_id: ci-quality-adapter-standard-selection
test('entrypoint executes the embedded standard without reading a project descriptor', () => executeEmbeddedStandard('result'));

// evidence_role: supplemental
// The absence of a project descriptor directory after a successful run is a file tree state that no contract guarantee observes.
// flow_id: ci-quality-adapter-standard-selection
test('entrypoint leaves no project descriptor directory after executing the embedded standard', () => executeEmbeddedStandard('descriptor-directory'));

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
    expect(statusMatchesResults(saved)).toBe(true);
    expectPublishedResult(run, saved.status);
    expect(saved.results.map((entry: { id: string }) => entry.id)).toStrictEqual(scope === 'native'
      ? ['toolchain-verify', 'dependency-restore', 'lint', 'test', 'structure']
      : ['toolchain-verify', 'dependency-restore', 'format', 'lint', 'test', 'security', 'dependency-policy', 'structure']);
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
    expect(run.result.status, run.result.stderr).toBe(1);
    expect(run.result.stderr + run.result.stdout).toMatch(/quality-adapter-(execution-scope-invalid|native-scope-unsupported)/);
    expect(fs.readFileSync(log, 'utf8')).toBe('');
    expect(fs.existsSync(run.resultPath)).toBe(false);
    expect(run.filesAfter).toEqual(run.filesBefore);
  }
});

const rustPolicyFixture = (root: string) => {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(root, 'runtime'));
  const log = path.join(root, 'commands.jsonl');
  fs.writeFileSync(log, '');
  fs.writeFileSync(path.join(root, 'runtime/Cargo.toml'), '[package]\nname="fixture"\nversion="0.1.0"\n');
  fs.writeFileSync(path.join(root, 'runtime/Cargo.lock'), '');
  fs.writeFileSync(path.join(root, 'runtime/deny.toml'), '');
  fs.writeFileSync(path.join(bin, 'rustc'), `#!${process.execPath}\nprocess.getBuiltinModule('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(['rustc', ...process.argv.slice(2)])+'\\n');\nconsole.log('rustc 1.80.0');\n`, { mode: 0o700 });
  fs.writeFileSync(path.join(bin, 'cargo'), `#!${process.execPath}\nconst fs=process.getBuiltinModule('node:fs');\nfs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2))+'\\n');\nif(process.argv[2]==='deny'){\n  if(process.env.DENY_OUTPUT_OVERFLOW==='true')fs.writeFileSync(1,'x'.repeat(2*1024*1024));\n  process.stderr.write(process.env.DENY_STDERR||'');\n  process.exitCode=Number(process.env.DENY_EXIT||0);\n}\n`, { mode: 0o700 });
  const inputs = { 'INPUT_BUNDLE-PATH': '', 'INPUT_STANDARD-BUNDLE-ID': 'rust-cargo-quality', 'INPUT_TOOLCHAIN-VERSION': '1.80.0', 'INPUT_LANGUAGE-PROFILE': 'rust',
    CI_CARGO_MANIFEST_PATH: 'runtime/Cargo.toml', CI_CARGO_LOCK_PATH: 'runtime/Cargo.lock', CI_CARGO_DENY_VERSION: '', CI_CARGO_DENY_CONFIG_PATH: '', PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const commands = () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { inputs, commands };
};

// contract_id: contract.ci-quality-adapter.outputs
// flow_id: ci-quality-adapter-dependency-policy
test('unconfigured dependency policy is recorded as not-run without changing the aggregate status', (t) => {
  // Arrange
  const root = fs.mkdtempSync(path.resolve(__dirname, '../../../tmp/ci-adapter-policy-unconfigured-'));
  t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const { inputs, commands } = rustPolicyFixture(root);
  // Act
  const run = runAction(root, 'ignored', inputs);
  const payload = JSON.parse(fs.readFileSync(run.resultPath, 'utf8'));
  // Assert
  expect(run.result.status, run.result.stdout + run.result.stderr).toBe(0);
  expect(payload.status).toBe('success');
  expect(statusMatchesResults(payload)).toBe(true);
  expectPublishedResult(run, payload.status);
  expect(payload.results.find((entry: { id: string }) => entry.id === 'dependency-policy')).toStrictEqual(expect.objectContaining({ status: 'not-run', reason: 'not-configured', exitCode: null }));
  expect(payload.results.filter((entry: { status: string }) => entry.status !== 'not-run').every((entry: { status: string }) => entry.status === 'success')).toBe(true);
  expect(commands().map(args => args[0])).not.toContain('deny');
  expect(fs.readFileSync(run.output, 'utf8')).toMatch(/status.*success/s);
  const timing = run.result.stderr.split('\n').filter(line => line.startsWith('ci-quality-command-timing:')).map(line => JSON.parse(line.slice('ci-quality-command-timing:'.length)))
    .find(entry => entry.id === 'dependency-policy');
  expect(timing).toStrictEqual(expect.objectContaining({ phase: 'command', status: 'not-run', exit_code: null }));
});

// contract_id: contract.ci-quality-adapter.outputs
// flow_id: ci-quality-adapter-dependency-policy
test('configured dependency policy runs cargo-deny with the declared configuration', (t) => {
  // Arrange
  const root = fs.mkdtempSync(path.resolve(__dirname, '../../../tmp/ci-adapter-policy-configured-'));
  t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const { inputs, commands } = rustPolicyFixture(root);
  for (const [exit, overflow, status] of [['0', 'false', 'success'], ['2', 'false', 'failed'], ['0', 'true', '判定不能']] as const) {
    fs.writeFileSync(path.join(root, 'commands.jsonl'), '');
    // Act
    const run = runAction(root, 'ignored', { ...inputs, CI_CARGO_DENY_VERSION: '0.20.2', CI_CARGO_DENY_CONFIG_PATH: 'runtime/deny.toml', DENY_EXIT: exit, DENY_OUTPUT_OVERFLOW: overflow });
    const payload = JSON.parse(fs.readFileSync(run.resultPath, 'utf8'));
    // Assert
    expect(run.result.status).toBe(status === 'success' ? 0 : 1);
    expect(payload.status).toBe(status);
    expect(statusMatchesResults(payload)).toBe(true);
    expectPublishedResult(run, payload.status);
    expect(payload.results.find((entry: { id: string }) => entry.id === 'dependency-policy').status).toBe(status);
    expect(fs.readFileSync(run.output, 'utf8')).toContain(`\n${status}\n`);
    expect(commands().find(args => args[0] === 'deny')).toStrictEqual(['deny', '--format', 'json', '--manifest-path', 'runtime/Cargo.toml', '--config', 'runtime/deny.toml', 'check', 'bans', 'licenses', 'sources']);
  }
});

// contract_id: contract.ci-quality-adapter.outputs
// flow_id: ci-quality-adapter-dependency-policy
test('failed dependency policy retains only validated cargo-deny identifiers', (t) => {
  // Arrange
  const root = fs.mkdtempSync(path.resolve(__dirname, '../../../tmp/ci-adapter-policy-diagnostics-'));
  t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const { inputs } = rustPolicyFixture(root);
  const diagnostic = (severity: string, code: string, krate: Record<string, string>) => JSON.stringify({ type: 'diagnostic', fields: {
    severity, code, message: 'private-message-text', labels: [{ message: 'private-label-text', span: 'token = "private-span-text"' }], graphs: [{ Krate: krate }] } });
  const stderr = [
    diagnostic('error', 'wildcard', { name: 'fixture', version: '0.1.0' }),
    diagnostic('error', 'Bad Code', { name: 'fixture', version: '0.1.0' }),
    diagnostic('error', 'banned', { name: 'private crate name', version: '1.0.0' }),
    diagnostic('error', 'banned', { name: 'prerelease', version: '1.0.0-alpha.1+build.1' }),
    diagnostic('error', 'banned', { name: 'malformed', version: '1.0.0-..' }),
    diagnostic('warning', 'duplicate', { name: 'syn', version: '2.0.0' }),
    'private plain text line',
    JSON.stringify({ type: 'summary', fields: { bans: { errors: 2, warnings: 1, helps: 0 }, licenses: { errors: 0, warnings: 0 }, unknown: { errors: 1, warnings: 0 } } }),
  ].join('\n');
  // Act
  const run = runAction(root, 'ignored', { ...inputs, CI_CARGO_DENY_VERSION: '0.20.2', CI_CARGO_DENY_CONFIG_PATH: 'runtime/deny.toml', DENY_EXIT: '2', DENY_STDERR: stderr });
  const published = fs.readFileSync(run.resultPath, 'utf8');
  const payload = JSON.parse(published);
  const entry = payload.results.find((result: { id: string }) => result.id === 'dependency-policy');
  // Assert
  expect(entry.status).toBe('failed');
  expect(statusMatchesResults(payload)).toBe(true);
  expectPublishedResult(run, payload.status);
  expect(entry.diagnostics).toStrictEqual({
    checks: { bans: { errors: 2, warnings: 1 }, licenses: { errors: 0, warnings: 0 } },
    findings: [{ severity: 'error', code: 'wildcard', crates: [{ name: 'fixture', version: '0.1.0' }] }, { severity: 'error', code: 'banned', crates: [] },
      { severity: 'error', code: 'banned', crates: [{ name: 'prerelease', version: '1.0.0-alpha.1+build.1' }] }, { severity: 'error', code: 'banned', crates: [] }],
    omittedFindings: 0,
  });
  expect(entry.stderr).toBe('protected-child-output');
  for (const output of [published, run.result.stdout, run.result.stderr]) {
    expect(output).not.toMatch(/private-(message|label|span)-text|private crate name|private plain text line/);
  }
});

// contract_id: contract.ci-quality-adapter.outputs
// flow_id: ci-quality-adapter-dependency-policy
test('dependency policy rejects an unusable configuration before commands', (t) => {
  // Arrange
  const root = fs.mkdtempSync(path.resolve(__dirname, '../../../tmp/ci-adapter-policy-unusable-'));
  t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const { inputs, commands } = rustPolicyFixture(root);
  fs.mkdirSync(path.join(root, 'runtime/deny-directory'));
  for (const [config, code] of [['runtime/missing-deny.toml', 'environment-path-missing'], ['runtime/deny-directory', 'environment-path-missing'],
    [path.join(root, 'runtime/deny.toml'), 'environment-path-invalid'], ['../deny.toml', 'environment-path-missing']] as const) {
    for (const scope of ['all', 'native']) {
      // Act
      const run = runAction(root, 'ignored', { ...inputs, 'INPUT_EXECUTION-SCOPE': scope, CI_CARGO_DENY_VERSION: '0.20.2', CI_CARGO_DENY_CONFIG_PATH: config });
      // Assert
      expect(run.result.status, `${scope} ${config}`).toBe(1);
      expect(run.result.stderr).toMatch(/^ci-failure-diagnostic:.*"stage":"adapter-execution"/m);
      expect(run.result.stderr).toContain(`"reason":"quality-adapter-${code}"`);
      expect(commands()).toStrictEqual([]);
    }
  }
});

// contract_id: contract.ci-quality-adapter.outputs
// flow_id: ci-quality-adapter-dependency-policy
test('dependency policy rejects incomplete inputs before commands', (t) => {
  // Arrange
  const root = fs.mkdtempSync(path.resolve(__dirname, '../../../tmp/ci-adapter-policy-incomplete-'));
  t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const { inputs, commands } = rustPolicyFixture(root);
  for (const partial of [{ CI_CARGO_DENY_VERSION: '0.20.2' }, { CI_CARGO_DENY_CONFIG_PATH: 'runtime/deny.toml' }]) {
    for (const scope of ['all', 'native']) {
      // Act
      const run = runAction(root, 'ignored', { ...inputs, 'INPUT_EXECUTION-SCOPE': scope, ...partial });
      // Assert
      expect(run.result.status, scope).toBe(1);
      expect(run.result.stderr).toMatch(/^ci-failure-diagnostic:.*"stage":"adapter-execution"/m);
      expect(run.result.stderr).toContain('"reason":"quality-adapter-optional-command-incomplete"');
      expect(commands()).toStrictEqual([]);
    }
  }
});

// contract_id: contract.ci-failure-diagnostics.existing-state
// flow_id: ci-quality-adapter-dependency-policy
test('dependency policy rejection leaves no result file', (t) => {
  // Arrange
  const root = fs.mkdtempSync(path.resolve(__dirname, '../../../tmp/ci-adapter-policy-no-result-'));
  t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const { inputs } = rustPolicyFixture(root);
  fs.mkdirSync(path.join(root, 'runtime/deny-directory'));
  const rejected = [...['runtime/missing-deny.toml', 'runtime/deny-directory', path.join(root, 'runtime/deny.toml'), '../deny.toml']
    .map((config) => ({ CI_CARGO_DENY_VERSION: '0.20.2', CI_CARGO_DENY_CONFIG_PATH: config })),
  { CI_CARGO_DENY_VERSION: '0.20.2' }, { CI_CARGO_DENY_CONFIG_PATH: 'runtime/deny.toml' }];
  for (const partial of rejected) {
    for (const scope of ['all', 'native']) {
      // Act
      const run = runAction(root, 'ignored', { ...inputs, 'INPUT_EXECUTION-SCOPE': scope, ...partial });
      // Assert
      expect(run.result.status, scope).toBe(1);
      expect(fs.existsSync(run.resultPath)).toBe(false);
      expect(run.filesAfter).toStrictEqual(run.filesBefore);
    }
  }
});

// contract_id: contract.ci-quality-adapter.outputs
// flow_id: ci-quality-adapter-execution-scope
test('native Rust scope retains toolchain preparation and native command failure', (t) => {
  // Arrange
  const root = fs.mkdtempSync(path.resolve(__dirname, '../../../tmp/ci-adapter-native-failure-'));
  t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const commands = path.join(root, 'cargo-commands.jsonl');
  fs.writeFileSync(path.join(root, 'Cargo.toml'), ''); fs.writeFileSync(path.join(root, 'Cargo.lock'), '');
  const inputs = { 'INPUT_BUNDLE-PATH': '', 'INPUT_STANDARD-BUNDLE-ID': 'rust-cargo-quality', 'INPUT_EXECUTION-SCOPE': 'native',
    'INPUT_TOOLCHAIN-VERSION': '1.80.0', CI_CARGO_MANIFEST_PATH: 'Cargo.toml', CI_CARGO_LOCK_PATH: 'Cargo.lock', PATH: bin };
  // Act
  for (const failure of ['version-mismatch', 'version-nonzero', 'rustc-unavailable', 'cargo-unavailable', 'fetch', 'clippy', 'test', 'metadata'] as const) {
    const unavailable = failure.endsWith('-unavailable');
    const missingInterpreter = `#!${path.join(bin, 'missing-interpreter')}\n`;
    const rustc = failure === 'rustc-unavailable' ? missingInterpreter
      : `#!${process.execPath}\nconsole.log('rustc '+(process.env.FAIL_COMMAND==='version-mismatch'?'0.0.0':'1.80.0'));\nif(process.env.FAIL_COMMAND==='version-nonzero'){console.error('native-toolchain-private-output');process.exit(7);}\n`;
    fs.writeFileSync(commands, '');
    const cargo = failure === 'cargo-unavailable' ? missingInterpreter
      : `#!${process.execPath}\nprocess.getBuiltinModule('node:fs').appendFileSync(${JSON.stringify(commands)}, JSON.stringify(process.argv[2])+'\\n');\nprocess.exit(process.argv[2]===process.env.FAIL_COMMAND?7:0);\n`;
    fs.writeFileSync(path.join(bin, 'rustc'), rustc, { mode: 0o700 });
    fs.writeFileSync(path.join(bin, 'cargo'), cargo, { mode: 0o700 });
    const run = runAction(root, 'invalid ignored descriptor', { ...inputs, FAIL_COMMAND: failure });
    const payload = JSON.parse(fs.readFileSync(run.resultPath, 'utf8'));
    // Assert
    expect(run.result.status).toBe(1);
    const status = unavailable ? '判定不能' : 'failed';
    const versionRejected = failure.startsWith('version-');
    const reason = versionRejected ? 'quality-adapter-toolchain-version-mismatch' : unavailable ? 'quality-adapter-unresolved' : 'quality-adapter-failed';
    expect(payload.status).toBe(status);
    expect(statusMatchesResults(payload)).toBe(true);
    expectPublishedResult(run, payload.status);
    const diagnostics = run.result.stderr.split('\n').filter(line => line.startsWith('ci-failure-diagnostic:'))
      .map(line => JSON.parse(line.slice('ci-failure-diagnostic:'.length)));
    expect(diagnostics).toContainEqual(expect.objectContaining({ classification: expect.objectContaining({ stage: 'adapter-result', reason }) }));
    expect(fs.readFileSync(run.output, 'utf8')).toContain(status);
    const nativeIds = ['toolchain-verify', 'dependency-restore', 'lint', 'test', 'structure'];
    const failedId = { 'version-mismatch': 'toolchain-verify', 'version-nonzero': 'toolchain-verify', 'rustc-unavailable': 'toolchain-verify', 'cargo-unavailable': 'dependency-restore', fetch: 'dependency-restore', clippy: 'lint', test: 'test', metadata: 'structure' }[failure];
    const length = failedId === 'toolchain-verify' ? 1 : failedId === 'dependency-restore' ? 2 : 5;
    expect(payload.results.map((entry: { id: string; status: string }) => ({ id: entry.id, status: entry.status }))).toStrictEqual(
      nativeIds.slice(0, length).map(id => ({ id, status: id === failedId ? status : 'success' })),
    );
    const expectedCommands = length === 1 || failure === 'cargo-unavailable' ? []
      : length === 2 ? ['fetch'] : ['fetch', 'clippy', 'test', 'metadata'];
    expect(fs.readFileSync(commands, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)))
      .toStrictEqual(expectedCommands);
    if (versionRejected) {
      const privateOutputs = failure === 'version-mismatch'
        ? ['rustc 0.0.0']
        : ['rustc 1.80.0', 'native-toolchain-private-output'];
      for (const output of [run.result.stdout, run.result.stderr, fs.readFileSync(run.resultPath, 'utf8'), fs.readFileSync(run.output, 'utf8')]) {
        for (const privateOutput of privateOutputs) {
          expect(output).not.toContain(privateOutput);
        }
      }
    }
  }

  const unwritable = runAction(root, 'invalid ignored descriptor', { ...inputs, FAIL_COMMAND: '' }, { outputWritable: false });
  expect(unwritable.result.status).toBe(1);
  expect(JSON.parse(fs.readFileSync(unwritable.resultPath, 'utf8')).status).toBe('success');
  expect(unwritable.result.stderr).toMatch(/^ci-failure-diagnostic:.*"stage":"output-write"/m);
});

// flow_id: ci-quality-adapter-entrypoint-regression
test('entrypoint rejects a non-read-only descriptor', () => {
  // Arrange
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-adapter-entry-'));

  // Act
  const run = runAction(root, descriptor('trusted-control'));
  const result = run.result;

  // Assert
  expect(result.status, result.stderr).toBe(1);
  expect(fs.readFileSync(run.output, 'utf8')).toMatch(/status.*failed/s);
  expect(fs.existsSync(run.resultPath)).toBe(false);
  expect(run.filesAfter).toEqual(run.filesBefore);
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
