import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { describe, expect, test, onTestFinished } from 'vitest';
import { parse } from 'yaml';

const root = process.cwd();
const require = createRequire(path.join(root, 'runtime/preset/package.json'));
const tsx = require.resolve('tsx');
const commands = [
  ['preset-assurance', 'ci-preset-assurance', ['--import', tsx, 'runtime/preset/validate-ci-preset.ts', '--unknown', 'value'], 2],
  ['asset-lock', 'ci-preset-assurance', ['--import', tsx, 'runtime/preset/generate-ci-asset-lock.ts', '--unknown', 'value'], 2],
  ['materialization', 'ci-preset-materialization', ['--import', tsx, 'runtime/adapter/materialize-adapter-bundle.ts'], 1],
  ['installer-cli', 'ci-release-supplemental-asset', ['runtime/installer/run-installer.mjs'], 1],
];

describe('runtime failure diagnostics', () => {
  test('standalone distribution diagnostics bind workflow context to the declared checkout', () => {
    const source = 'a'.repeat(40);
    const eventSha = 'b'.repeat(40);
    for (const declared of [source, '']) {
      const result = spawnSync(process.execPath, ['runtime/distribution/fetch-a3-ci-github.mjs', 'verify'], {
        cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true',
          GITHUB_RUN_ID: '123', GITHUB_JOB: 'verify_distribution', GITHUB_EVENT_NAME: 'pull_request',
          GITHUB_SHA: eventSha, CI_SOURCE_REVISION: declared },
      });
      expect(result.status).toBe(2);
      const { failureEvidence } = JSON.parse(result.stderr);
      expect(failureEvidence.context).toMatchObject({ run: '123', job: 'verify_distribution',
        source: declared || 'unavailable' });
      expect(failureEvidence['evidence-location'].log).toBe('workflow-run-job-step-log');
      expect(failureEvidence['execution-state'].lastConfirmed).toBe('unavailable');
      expect(result.stderr).not.toContain(eventSha);
    }
  });

  test.each([
    ['ci-rust-source-gate', 'profile-binding', { 'language-profile': 'invalid' }],
    ['ci-rust-release-build', 'input-validation', {
      'language-profile': 'invalid', 'platform-manifest': 'platforms.yml', 'toolchain-version': '1.80.0',
      'platform-id': 'fixture', 'platform-target': 'x86_64-unknown-linux-gnu', 'output-directory': 'output',
      'cargo-manifest-path': 'Cargo.toml', 'release-binary-name': 'fixture', 'release-asset-prefix': 'fixture',
    }],
    ['ci-github-toolchain-verifier', 'mode-validation', { mode: 'invalid', 'jq-version': '1.7.1' }],
  ])('%s composite shell step publishes the input rejection stage', (subject, stage, suppliedInputs) => {
    fs.mkdirSync(path.join(root, 'tests/tmp'), { recursive: true });
    const fixture = fs.mkdtempSync(path.join(root, 'tests/tmp/composite-diagnostic-'));
    onTestFinished(() => fs.rmSync(fixture, { recursive: true, force: true }));
    const authority = path.join(fixture, 'authority.json');
    const output = path.join(fixture, 'github-output');
    fs.writeFileSync(authority, JSON.stringify({ language_profile: 'rust' }));
    fs.writeFileSync(output, '');
    const actionPath = path.join(root, 'actions', subject);
    const action = parse(fs.readFileSync(path.join(actionPath, 'action.yml'), 'utf8'));
    expect(action.runs).toMatchObject({ using: 'composite', steps: [{ shell: 'bash' }] });
    const [step] = action.runs.steps;
    const inputs = { 'authority-path': authority, ...suppliedInputs };
    const bindings = Object.fromEntries(Object.entries(step.env).map(([variable, expression]) => {
      const input = /^\$\{\{ inputs\.([\w-]+) \}\}$/.exec(expression);
      expect(input, expression).not.toBeNull();
      return [variable, inputs[input[1]] ?? action.inputs[input[1]].default ?? ''];
    }));
    const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step.run], {
      cwd: fixture, encoding: 'utf8', env: { ...process.env, ...bindings,
        GITHUB_ACTIONS: 'true', GITHUB_ACTION_PATH: actionPath, GITHUB_OUTPUT: output },
    });
    expect(result.status).toBe(1);
    const diagnostic = result.stderr.match(/^ci-failure-diagnostic:(.+)$/m);
    expect(diagnostic, result.stderr).not.toBeNull();
    expect(JSON.parse(diagnostic[1]).classification).toMatchObject({ subject, stage });
    expect(fs.readFileSync(output, 'utf8')).toBe('');
  });

  // contract_id: contract.ci-failure-diagnostics.actionable
  // flow_id: runtime-failure-diagnostics
  test.each(commands)('%s preserves its outcome and safe diagnostic context', (_name, subject, args, status) => {
    for (const [githubActions, log] of [['false', 'stderr'], ['true', 'workflow-run-job-step-log']]) {
      const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: githubActions } });
      const line = result.stderr.split('\n').find(value => value.startsWith('ci-failure-diagnostic:'));
      const evidence = JSON.parse(line?.slice('ci-failure-diagnostic:'.length) ?? '{}');
      expect(result.status).toBe(status);
      expect(evidence.classification.subject).toBe(subject);
      expect(evidence.classification.stage).toBeTruthy();
      expect(evidence.context).toBeTruthy();
      expect(evidence.comparison).toBeTruthy();
      expect(evidence['execution-state'].outcome).toBe('failure');
      expect(evidence['evidence-location'].log).toBe(log);
      expect(evidence['next-check'].rule).toBe(evidence.classification.reason);
    }
  });

  // contract_id: contract.ci-failure-diagnostics.actionable
  test.each(['selection', 'delivery', 'application', 'rollback'])('distribution %s rejection preserves state and diagnostic context', operation => {
    fs.mkdirSync(path.resolve('tests/tmp'), { recursive: true });
    const directory = fs.mkdtempSync(path.resolve('tests/tmp/distribution-diagnostic-'));
    onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sentinel = path.join(directory, 'state');
    fs.writeFileSync(sentinel, 'unchanged');
    const [command, stage] = {
      selection: ['plan', 'plan'],
      delivery: ['fetch', 'input-validation'],
      application: ['apply', 'apply'],
      rollback: ['rollback', 'rollback'],
    }[operation];
    const result = spawnSync(process.execPath, ['runtime/distribution/fetch-a3-ci-github.mjs', command, '--repo-root', directory], { cwd: root, encoding: 'utf8' });
    const envelope = JSON.parse(result.stderr);
    expect(result.status).toBe(2);
    expect(envelope.failureEvidence.classification).toMatchObject({ subject: 'ci-selective-distribution', operation: command, stage });
    expect(envelope.failureEvidence['execution-state'].write).toBe('not-started');
    expect(envelope.failureEvidence['next-check'].rule).toBe(envelope.diagnostic);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('unchanged');
    expect(fs.readdirSync(directory)).toEqual(['state']);
  });

  // contract_id: contract.ci-failure-diagnostics.actionable
  test.each([
    ['source-gate', 'ci-rust-source-gate', 'runtime/rust-release/ci-source-gate.sh'],
    ['rust-build', 'ci-rust-release-build', 'runtime/rust-release/ci-release-build.sh'],
    ['github-toolchain', 'ci-github-toolchain-verifier', 'runtime/github-toolchain/verify-github-toolchain.sh'],
    ['distribution-publication', 'ci-selective-distribution', 'runtime/repository/manage-distribution-release.sh'],
    ['managed-source', 'repository-managed-source-integrity', 'runtime/repository/lint-repository.sh'],
  ])('%s rejects invalid invocation with retained shell failure context', (_name, subject, script) => {
    const result = spawnSync('bash', [script, 'invalid'], { cwd: root, encoding: 'utf8' });
    const line = result.stderr.split('\n').find(value => value.startsWith('ci-failure-diagnostic:'));
    const evidence = JSON.parse(line?.slice('ci-failure-diagnostic:'.length) ?? '{}');
    expect(result.status).not.toBe(0);
    expect(evidence.classification.subject).toBe(subject);
    expect(evidence['execution-state'].exit).toBe(result.status);
    expect(evidence['execution-state'].write).toBe('not-started');
    expect(evidence.classification.stage).toBeTruthy();
    expect(evidence['next-check'].rule).toBe(evidence.classification.stage);
  });
  // contract_id: contract.ci-failure-diagnostics.actionable
  test('repository distribution retains the failing metadata gate before build', () => {
    fs.mkdirSync(path.resolve('tests/tmp'), { recursive: true });
    const directory = fs.mkdtempSync(path.resolve('tests/tmp/dist-diagnostic-'));
    onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.mkdirSync(path.join(directory, 'actions/broken'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'actions/broken/action.yml'), 'name: broken\n');
    for (const file of ['runtime/repository/check-action-dist.mjs', 'runtime/diagnostics/failure.mjs']) {
      fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
      fs.copyFileSync(path.join(root, file), path.join(directory, file));
    }
    const result = spawnSync(process.execPath, [path.join(directory, 'runtime/repository/check-action-dist.mjs')], { cwd: directory, encoding: 'utf8' });
    const line = result.stderr.split('\n').find(value => value.startsWith('ci-failure-diagnostic:'));
    const evidence = JSON.parse(line.slice('ci-failure-diagnostic:'.length));
    expect(result.status).toBe(1);
    expect(evidence.classification).toMatchObject({ subject: 'repository-action-distribution', stage: 'action-metadata', reason: 'action-runtime-missing' });
    expect(evidence.comparison).toEqual({ field: 'runs.using', expected: 'declared-runtime', observed: 'missing' });
    expect(evidence['execution-state'].write).toBe('not-started');
  });

  // evidence_role: supplemental
  // The absent dist directory is a side effect of the failed gate, not an observation of the diagnostic guarantee.
  // contract_id: contract.ci-failure-diagnostics.actionable
  test('repository distribution metadata gate failure creates no dist directory', () => {
    fs.mkdirSync(path.resolve('tests/tmp'), { recursive: true });
    const directory = fs.mkdtempSync(path.resolve('tests/tmp/dist-absence-'));
    onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.mkdirSync(path.join(directory, 'actions/broken'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'actions/broken/action.yml'), 'name: broken\n');
    for (const file of ['runtime/repository/check-action-dist.mjs', 'runtime/diagnostics/failure.mjs']) {
      fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
      fs.copyFileSync(path.join(root, file), path.join(directory, file));
    }
    spawnSync(process.execPath, [path.join(directory, 'runtime/repository/check-action-dist.mjs')], { cwd: directory, encoding: 'utf8' });
    expect(fs.existsSync(path.join(directory, 'actions/broken/dist'))).toBe(false);
  });


// contract_id: contract.ci-failure-diagnostics.actionable
// flow_id: runtime-failure-diagnostics
test('distribution gate retains its status when the final sink fails', () => {
  fs.mkdirSync(path.resolve('tests/tmp'), { recursive: true });
  const fixture = fs.mkdtempSync(path.resolve('tests/tmp/distribution-sink-'));
  onTestFinished(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.mkdirSync(path.join(fixture, 'runtime/repository'), { recursive: true });
  fs.mkdirSync(path.join(fixture, 'runtime/diagnostics'), { recursive: true });
  fs.mkdirSync(path.join(fixture, 'actions/broken'), { recursive: true });
  fs.writeFileSync(path.join(fixture, 'actions/broken/action.yml'), 'name: broken\n');
  for (const file of ['runtime/repository/check-action-dist.mjs', 'runtime/diagnostics/failure.mjs']) fs.copyFileSync(file, path.join(fixture, file));
  const entrypoint = path.join(fixture, 'runtime/repository/check-action-dist.mjs');
  const driver = `process.argv[1]=${JSON.stringify(entrypoint)};process.stderr.write=()=>{throw new Error('private-sink-failure')};process.on('uncaughtException',()=>{process.exitCode=88});process.on('unhandledRejection',()=>{process.exitCode=88});await import(${JSON.stringify(entrypoint)});`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', driver], { encoding: 'utf8', cwd: path.resolve('tests') });
  expect(result.status).toBe(1);
  expect(result.stdout + result.stderr).toBe('');
});

});
