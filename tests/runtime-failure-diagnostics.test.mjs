import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { describe, expect, test, onTestFinished } from 'vitest';

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
    const command = { selection: 'plan', delivery: 'fetch', application: 'apply', rollback: 'rollback' }[operation];
    const result = spawnSync(process.execPath, ['runtime/distribution/fetch-a3-ci-github.mjs', command, '--repo-root', directory], { cwd: root, encoding: 'utf8' });
    const envelope = JSON.parse(result.stderr);
    expect(result.status).toBe(2);
    expect(envelope.failureEvidence.classification).toMatchObject({ subject: 'ci-selective-distribution', operation: command });
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
    expect(evidence['next-check'].rule).toBe(evidence.classification.stage);
  });
  // contract_id: contract.ci-failure-diagnostics.actionable
  test('repository distribution retains the failing metadata gate before build', () => {
    fs.mkdirSync(path.resolve('tests/tmp'), { recursive: true });
    const directory = fs.mkdtempSync(path.resolve('tests/tmp/dist-diagnostic-'));
    onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.mkdirSync(path.join(directory, 'actions/broken'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'actions/broken/action.yml'), 'name: broken\n');
    const driver = `import { checkActionDist } from ${JSON.stringify(path.join(root, 'runtime/repository/check-action-dist.mjs'))};import { FailureContext } from ${JSON.stringify(path.join(root, 'runtime/diagnostics/failure.mjs'))};try { await checkActionDist(process.argv[1]); } catch(error) { new FailureContext('repository-action-distribution','check-distribution').report(error);process.exitCode=1; }`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', driver, directory], { encoding: 'utf8' });
    const line = result.stderr.split('\n').find(value => value.startsWith('ci-failure-diagnostic:'));
    const evidence = JSON.parse(line.slice('ci-failure-diagnostic:'.length));
    expect(result.status).toBe(1);
    expect(evidence.classification).toMatchObject({ subject: 'repository-action-distribution', stage: 'action-metadata', reason: 'action-runtime-missing' });
    expect(evidence.comparison).toEqual({ field: 'runs.using', expected: 'declared-runtime', observed: 'missing' });
    expect(evidence['execution-state'].write).toBe('not-started');
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
