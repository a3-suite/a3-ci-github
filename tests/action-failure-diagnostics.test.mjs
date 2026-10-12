import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { describe, expect, test, onTestFinished } from 'vitest';

const actions = fs.readdirSync('actions').filter((name) => fs.existsSync(`actions/${name}/src/index.ts`));
describe.each(actions)('%s failure boundary', (action) => {
  // contract_id: contract.ci-failure-diagnostics.actionable
  // integration_id: action-failure-diagnostics
  test.each(['source', 'dist'])('%s retains actionable input failure without private input values', (surface) => {
    fs.mkdirSync(path.resolve('tests/tmp'), { recursive: true });
    const fixture = fs.mkdtempSync(path.resolve('tests/tmp/action-failure-'));
    onTestFinished(() => fs.rmSync(fixture, { recursive: true, force: true }));
    const output = path.join(fixture, 'output');
    const sentinel = path.join(fixture, 'existing-state');
    fs.writeFileSync(output, '');
    fs.writeFileSync(sentinel, 'unchanged');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('INPUT_')));
    Object.assign(env, { GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output, GH_TOKEN: 'private-token-must-not-appear', RUNNER_TEMP: fixture, GITHUB_PATH: path.join(fixture, 'path'), GITHUB_RUN_ID: '123', GITHUB_JOB: 'diagnostic-test' });
    const root = path.resolve('actions', action);
    const require = createRequire(path.join(root, 'package.json'));
    const args = surface === 'source' ? ['--import', require.resolve('tsx'), path.join(root, 'src/index.ts')] : [path.join(root, 'dist/index.js')];
    const result = spawnSync(process.execPath, args, { env, encoding: 'utf8' });
    const line = result.stderr.split('\n').find((value) => value.startsWith('ci-failure-diagnostic:'));
    const evidence = JSON.parse(line?.slice('ci-failure-diagnostic:'.length) ?? '{}');
    expect(result.status).toBe(action === 'ci-change-scope' ? 0 : 1);
    expect(evidence.classification.subject).toBe(action);
    expect(evidence.classification.reason).not.toBe('unknown-failure');
    expect(evidence.classification.stage).toBeTruthy();
    expect(evidence.context).toMatchObject({ run: '123', job: 'diagnostic-test' });
    expect(evidence.comparison).toBeTruthy();
    expect(evidence['evidence-location']).toMatchObject({ log: 'workflow-run-job-step-log', artifact: 'not-generated' });
    expect(evidence['execution-state'].outcome).toBe(action === 'ci-change-scope' ? 'unresolved' : 'failure');
    expect(evidence['next-check'].rule).toBe(evidence.classification.reason);
    expect(result.stdout + result.stderr).not.toContain('private-token-must-not-appear');
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('unchanged');
    expect(fs.readFileSync(output, 'utf8')).not.toContain('success');
  });
});

describe('failure output retention', () => {
// contract_id: contract.ci-failure-diagnostics.actionable
// integration_id: failure-output-retention
  test.each(['source', 'dist'])('%s preserves primary failure when failure outputs cannot be written', (surface) => {
  fs.mkdirSync(path.resolve('tests/tmp'), { recursive: true });
  const fixture = fs.mkdtempSync(path.resolve('tests/tmp/output-failure-'));
  onTestFinished(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const root = path.resolve('actions/ci-config-snapshot');
  const require = createRequire(path.join(root, 'package.json'));
  const args = surface === 'source' ? ['--import', require.resolve('tsx'), path.join(root, 'src/index.ts')] : [path.join(root, 'dist/index.js')];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: fixture, 'INPUT_SOURCES-JSON': '', 'INPUT_SNAPSHOT-PATH': '' } });
  const evidence = result.stderr.split('\n').filter(line => line.startsWith('ci-failure-diagnostic:')).map(line => JSON.parse(line.slice('ci-failure-diagnostic:'.length)));
  expect(result.status).toBe(1);
  expect(evidence[0].classification.reason).toBe('input-missing');
  expect(evidence[1].classification.stage).toBe('failure-output-write');
  expect(evidence[1].context.inputs.primaryFailureRetained).toBe(true);
  expect(result.stderr).not.toContain(fixture);
  expect(result.stderr).not.toMatch(/at .*index/);
});
});

// contract_id: contract.ci-failure-diagnostics.actionable
// integration_id: failure-output-retention
describe.each(actions)('%s final sink retention', (action) => {
  test.each(['source', 'dist'])('%s retains failure status when public sinks throw', (surface) => {
    const root = path.resolve('actions', action);
    const require = createRequire(path.join(root, 'package.json'));
    const entrypoint = path.join(root, surface === 'source' ? 'src/index.ts' : 'dist/index.js');
    const args = surface === 'source' ? ['--import', require.resolve('tsx')] : [];
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('INPUT_')));
    Object.assign(env, { GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: '', GH_TOKEN: '' });
    const driver = `process.stderr.write=()=>{throw new Error('private-sink-failure')};process.stdout.write=()=>{throw new Error('private-sink-failure')};process.on('uncaughtException',()=>{process.exitCode=88});process.on('unhandledRejection',()=>{process.exitCode=88});await import(${JSON.stringify(entrypoint)});`;
    const result = spawnSync(process.execPath, [...args, '--input-type=module', '-e', driver], { env, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toBe('');
  });
});

// contract_id: contract.ci-failure-diagnostics.actionable
// integration_id: action-failure-diagnostics
describe('owner validation comparisons', () => {
  test.each(['source', 'dist'])('%s retains owner field comparisons without private values', (surface) => {
    fs.mkdirSync(path.resolve('tests/tmp'), { recursive: true });
    const fixture = fs.mkdtempSync(path.resolve('tests/tmp/owner-comparison-'));
    onTestFinished(() => fs.rmSync(fixture, { recursive: true, force: true }));
    const matrix = path.join(fixture, 'matrix.yml');
    fs.writeFileSync(matrix, 'platforms:\n  - id: linux\n    runner: ubuntu-24.04\n    target: x64\n  - id: linux\n    runner: ubuntu-24.04\n    target: arm\n');
    const plan = path.join(fixture, 'plan.json');
    fs.writeFileSync(plan, JSON.stringify({ strategy: 'ciGenerated', template: '1.{PATCH}', components: { OTHER: 'private-unused-component' } }));
    for (const [action, inputs, expected] of [
      ['ci-config-snapshot', { 'INPUT_SOURCES-JSON': JSON.stringify({ workflow: { API_KEY: 'private-value\n' } }), 'INPUT_SNAPSHOT-PATH': path.join(fixture, 'snapshot.json') }, { stage: 'value-validation', source: 'workflow', field: 'API_KEY', expected: 'nonempty-single-line-string', observed: 'invalid-or-protected' }],
      ['ci-platform-matrix', { 'INPUT_MANIFEST-PATH': matrix }, { stage: 'manifest-identity-validation', field: 'platforms[1].id', index: 1, expected: 'unique-valid-platform-identity', observed: 'linux', duplicate: true }],
      ['ci-publish-version', { 'INPUT_VERSION-PLAN-JSON': plan }, { stage: 'template-expansion', strategy: 'ciGenerated', field: 'PATCH', expected: 'declared-component', observed: 'missing' }],
    ]) {
      const root = path.resolve('actions', action);
      const require = createRequire(path.join(root, 'package.json'));
      const args = surface === 'source' ? ['--import', require.resolve('tsx'), path.join(root, 'src/index.ts')] : [path.join(root, 'dist/index.js')];
      const output = path.join(fixture, 'output');
      fs.writeFileSync(output, '');
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('INPUT_')));
      const result = spawnSync(process.execPath, args, { env: { ...env, ...inputs, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output }, encoding: 'utf8' });
      const line = result.stderr.split('\n').find(line => line.startsWith('ci-failure-diagnostic:'));
      const evidence = JSON.parse(line?.slice('ci-failure-diagnostic:'.length) ?? '{}');
      expect(result.status).toBe(1);
      expect(evidence.comparison).toMatchObject(expected);
      expect(result.stdout + result.stderr).not.toContain('private-');
      expect(fs.readFileSync(output, 'utf8')).not.toContain('success');
    }
  });
});
