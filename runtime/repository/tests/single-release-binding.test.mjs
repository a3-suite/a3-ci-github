import { describe, test, expect, onTestFinished } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';
import { checkRepository, repositorySnapshot, registryPath } from '../check-provider-references.mjs';
import { planActionReferenceUpdate, applyActionReferenceUpdate } from '../update-action-references.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const failure = (operation) => { try { operation(); } catch (error) { return error.message; } };
const fixture = () => {
  mkdirSync(path.join(root, 'tmp'), { recursive: true });
  const directory = mkdtempSync(path.join(root, 'tmp/single-release-binding-'));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: 'pipe' }).trim();
  const write = (relative, bytes) => { mkdirSync(path.dirname(path.join(directory, relative)), { recursive: true }); writeFileSync(path.join(directory, relative), bytes); };
  git('init', '-b', 'main'); git('config', 'user.name', 'Binding Test'); git('config', 'user.email', 'binding@example.invalid'); git('config', 'commit.gpgsign', 'false'); git('config', 'core.autocrlf', 'false');
  const zero = '0'.repeat(40);
  const registry = yaml.parse(readFileSync(path.join(root, registryPath), 'utf8'));
  registry.actionization.implementationSource = { repository: 'a3-suite/a3-ci-github', releaseTag: 'v0.2.10', exactRef: zero };
  const steps = ['ci-quality-adapter', 'ci-release-publication-control', 'ci-jq-provisioner', 'ci-github-toolchain-verifier'].map((name) => {
    const actionPath = `actions/${name}`;
    const action = yaml.parse(readFileSync(path.join(root, actionPath, 'action.yml'), 'utf8'));
    write(`${actionPath}/action.yml`, readFileSync(path.join(root, actionPath, 'action.yml')));
    if (action.runs.main) write(`${actionPath}/${action.runs.main}`, readFileSync(path.join(root, actionPath, action.runs.main)));
    return { uses: `a3-suite/a3-ci-github/${actionPath}@${zero}`, env: { A3_INSTALLER_PROVIDER_REVISION: zero }, with: Object.fromEntries(Object.entries(action.inputs).filter(([, value]) => value.required && !Object.hasOwn(value, 'default')).map(([key]) => [key, 'fixed'])) };
  });
  write(registryPath, yaml.stringify(registry)); write('VERSION', '0.2.10\n'); write('runtime/payload.mjs', 'export const payload = 1;\n');
  write('runtime/github-toolchain/verify-github-toolchain.sh', readFileSync(path.join(root, 'runtime/github-toolchain/verify-github-toolchain.sh')));
  write('actions/ci-quality-adapter/scripts/composite.sh', '#!/bin/sh\nexit 0\n');
  for (const name of ['ci-quality', 'ci-quality-platforms', 'ci-package-preparation', 'ci-release-publication', 'ci-package-publication']) write(`.github/workflows/${name}.yml`, yaml.stringify({ jobs: { checked: { steps } } }));
  git('add', '.'); git('commit', '-m', 'base');
  write('VERSION', '0.2.11\n'); git('add', '.'); git('commit', '-m', 'implementation');
  return { directory, git, write, implementation: git('rev-parse', 'HEAD') };
};

// flow_id: single-release-binding
describe('contract.ci-selective-distribution.publication', () => {
  test.each(['release/0.2.11', 'hotfix/0.2.11'])('one Release connects an untagged implementation on %s', (branch) => {
    // Arrange
    const f = fixture(); f.git('switch', '-c', branch);
    // Act
    const plan = planActionReferenceUpdate(f.directory, 'v0.2.11', f.implementation);
    // Assert
    expect(f.git('tag', '--list')).toBe(''); expect(plan.connection.diagnostics).toEqual([]);
    // Act
    applyActionReferenceUpdate(f.directory, plan);
    const repeated = planActionReferenceUpdate(f.directory, 'v0.2.11', f.implementation);
    // Assert
    expect(repeated.changedPaths).toEqual([]);
    // Arrange
    f.git('add', '.');
    // Act
    const candidate = checkRepository(f.directory, true, { candidate: true });
    // Assert
    expect(candidate.implementationBinding.implementationBindingStatus).toBe('verified');
    // Arrange
    f.git('add', '.'); f.git('commit', '-m', 'connect implementation'); f.git('tag', '-a', 'v0.2.11', '-m', 'single release');
    // Act
    const checked = checkRepository(f.directory, false, { releaseTag: 'v0.2.11' });
    const executed = spawnSync(process.execPath, [path.join(root, 'runtime/repository/check-provider-references.mjs'), '--contracts', '--release-tag', 'v0.2.11'], { cwd: f.directory, encoding: 'utf8' });
    const metadataOnly = spawnSync(process.execPath, [path.join(root, 'runtime/repository/check-provider-references.mjs')], { cwd: f.directory, encoding: 'utf8' });
    // Assert
    expect(checked.diagnostics).toEqual([]); expect(checked.implementationBinding.implementationBindingStatus).toBe('verified');
    expect(checked.implementationBinding.sourceRevision).not.toBe(f.implementation);
    expect(f.git('tag', '--list')).toBe('v0.2.11');
    expect(executed.status, executed.stderr).toBe(0); expect(JSON.parse(executed.stdout).connection.diagnostics).toEqual([]);
    expect(JSON.parse(executed.stdout).implementationBindingStatus).toBe('verified');
    expect(metadataOnly.status).toBe(0); expect(JSON.parse(metadataOnly.stdout).implementationBindingStatus).toBe('unverified');
    // Arrange
    const workflow = yaml.parse(readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8'));
    const gate = workflow.jobs['prepare-distribution'].steps.find((step) => step.id === 'provider-binding');
    const script = gate.run.replace('node runtime/repository/check-provider-references.mjs', `node "${path.join(root, 'runtime/repository/check-provider-references.mjs')}"`);
    const output = path.join(f.directory, 'tmp/binding-output'); f.write('tmp/binding-output', '');
    const runGate = () => spawnSync('bash', ['-c', script], { cwd: f.directory, encoding: 'utf8', env: { ...process.env, RELEASE_TAG: 'v0.2.11', GITHUB_OUTPUT: output } });
    // Act
    const gateResult = runGate();
    // Assert
    expect(gateResult.status).toBe(0);
    expect(readFileSync(output, 'utf8')).toBe(`implementation_source_sha=${f.implementation}\nimplementation_binding_status=verified\n`);
    // Arrange
    f.write('runtime/payload.mjs', 'export const payload = 2;\n'); f.write('tmp/binding-output', '');
    // Act
    const rejectedGate = runGate();
    // Assert
    expect(rejectedGate.status).not.toBe(0); expect(readFileSync(output, 'utf8')).toBe('');
  });

  test.each(['VERSION', 'runtime/payload.mjs', 'actions/ci-quality-adapter/action.yml', 'actions/ci-quality-adapter/dist/index.js', 'actions/ci-quality-adapter/scripts/composite.sh'])('single Release rejects changed execution input %s', (relative) => {
    // Arrange
    const f = fixture(); applyActionReferenceUpdate(f.directory, planActionReferenceUpdate(f.directory, 'v0.2.11', f.implementation));
    f.write(relative, relative === 'VERSION' ? '0.2.12\n' : `${readFileSync(path.join(f.directory, relative), 'utf8')}\n`);
    f.git('add', '.'); f.git('commit', '-m', 'invalid final source'); f.git('tag', '-a', 'v0.2.11', '-m', 'invalid source');
    // Act
    const rejected = failure(() => checkRepository(f.directory, false, { releaseTag: 'v0.2.11' }));
    // Assert
    expect(rejected).toMatch(/version-mismatch|closure-mismatch/);
  });

  test('candidate updates reject missing and unrelated implementation commits and preserve approval inputs', () => {
    // Arrange
    const f = fixture();
    const tree = f.git('rev-parse', 'HEAD^{tree}');
    const unrelated = f.git('commit-tree', tree, '-m', 'unrelated implementation');
    // Act
    const missingArgument = failure(() => planActionReferenceUpdate(f.directory, 'v0.2.11'));
    const missingObject = failure(() => planActionReferenceUpdate(f.directory, 'v0.2.11', 'f'.repeat(40)));
    const unrelatedObject = failure(() => planActionReferenceUpdate(f.directory, 'v0.2.11', unrelated));
    // Assert
    expect(missingArgument).toMatch(/full implementation/); expect(missingObject).toBeDefined(); expect(unrelatedObject).toMatch(/not-contained/);
    // Arrange
    const plan = planActionReferenceUpdate(f.directory, 'v0.2.11', f.implementation);
    f.write(registryPath, `${plan.before.get(registryPath)}\n# changed after plan\n`);
    // Act
    const changedInput = failure(() => applyActionReferenceUpdate(f.directory, plan));
    // Assert
    expect(changedInput).toMatch(/input changed/);
    expect(repositorySnapshot(f.directory).registry.actionization.implementationSource.exactRef).toBe('0'.repeat(40));
  });

  test('candidate application rejects closure changes and symlink destinations without writing references', () => {
    // Arrange
    const f = fixture(); const plan = planActionReferenceUpdate(f.directory, 'v0.2.11', f.implementation);
    f.write('runtime/payload.mjs', 'export const payload = 2;\n');
    // Act
    const changedClosure = failure(() => applyActionReferenceUpdate(f.directory, plan));
    // Assert
    expect(changedClosure).toMatch(/execution-assets-dirty/);
    expect(readFileSync(path.join(f.directory, registryPath), 'utf8')).toBe(plan.before.get(registryPath));
    // Arrange
    f.git('restore', 'runtime/payload.mjs');
    f.write('registry-copy.yml', plan.before.get(registryPath)); unlinkSync(path.join(f.directory, registryPath));
    symlinkSync(path.join(f.directory, 'registry-copy.yml'), path.join(f.directory, registryPath));
    // Act
    const redirected = failure(() => applyActionReferenceUpdate(f.directory, plan));
    // Assert
    expect(redirected).toMatch(/symlink update/);
    expect(readFileSync(path.join(f.directory, 'registry-copy.yml'), 'utf8')).toBe(plan.before.get(registryPath));
  });

  test('single Release rejects changed execution file modes', () => {
    // Arrange
    const f = fixture(); applyActionReferenceUpdate(f.directory, planActionReferenceUpdate(f.directory, 'v0.2.11', f.implementation));
    chmodSync(path.join(f.directory, 'actions/ci-quality-adapter/scripts/composite.sh'), 0o755);
    f.git('add', '.'); f.git('commit', '-m', 'change execution mode'); f.git('tag', '-a', 'v0.2.11', '-m', 'invalid closure');
    // Act
    const rejected = failure(() => checkRepository(f.directory, false, { releaseTag: 'v0.2.11' }));
    // Assert
    expect(rejected).toMatch(/closure-mismatch/);
  });

  test('single Release rejects stale workflow and installer bindings and invalid interfaces', () => {
    for (const mismatch of ['workflow', 'installer', 'interface']) {
      // Arrange
      const f = fixture(); applyActionReferenceUpdate(f.directory, planActionReferenceUpdate(f.directory, 'v0.2.11', f.implementation));
      const relative = '.github/workflows/ci-quality.yml'; const value = yaml.parse(readFileSync(path.join(f.directory, relative), 'utf8'));
      const step = value.jobs.checked.steps[0];
      if (mismatch === 'workflow') step.uses = step.uses.replace(f.implementation, 'f'.repeat(40));
      if (mismatch === 'installer') step.env.A3_INSTALLER_PROVIDER_REVISION = 'f'.repeat(40);
      if (mismatch === 'interface') step.with['undeclared-input'] = 'invalid';
      f.write(relative, yaml.stringify(value)); f.git('add', '.'); f.git('commit', '-m', 'stale connection'); f.git('tag', '-a', 'v0.2.11', '-m', 'invalid connection');
      // Act
      const result = spawnSync(process.execPath, [path.join(root, 'runtime/repository/check-provider-references.mjs'), '--contracts', '--release-tag', 'v0.2.11'], { cwd: f.directory, encoding: 'utf8' });
      // Assert
      expect(result.status).toBe(1); expect(JSON.parse(result.stdout).implementationBindingStatus).toBe('rejected');
    }
  });

  test('single Release cannot validate an unexecutable fixed bundle or bypass execution checks', () => {
    // Arrange
    const f = fixture(); f.write('actions/ci-quality-adapter/dist/index.js', 'const = ;'); f.git('add', '.'); f.git('commit', '-m', 'broken implementation');
    const sha = f.git('rev-parse', 'HEAD');
    // Act
    const rejectedCandidate = failure(() => planActionReferenceUpdate(f.directory, 'v0.2.11', sha));
    // Assert
    expect(rejectedCandidate).toMatch(/execution unavailable/);
    // Arrange
    for (const relative of [registryPath, ...repositorySnapshot(f.directory).targets]) {
      f.write(relative, readFileSync(path.join(f.directory, relative), 'utf8').replaceAll('0'.repeat(40), sha).replace('releaseTag: v0.2.10', 'releaseTag: v0.2.11'));
    }
    f.git('add', '.'); f.git('commit', '-m', 'broken binding'); f.git('tag', '-a', 'v0.2.11', '-m', 'invalid behavior');
    const cli = (...args) => spawnSync(process.execPath, [path.join(root, 'runtime/repository/check-provider-references.mjs'), ...args], { cwd: f.directory, encoding: 'utf8' });
    // Act
    const result = cli('--contracts', '--release-tag', 'v0.2.11');
    const bypass = cli('--release-tag', 'v0.2.11');
    // Assert
    expect(result.status).toBe(2); expect(result.stderr).toContain('execution unavailable');
    expect(bypass.status).toBe(2);
  });

  test.each(['main', 'pre', 'post', 'composite', 'composite-bare', 'composite-quoted', 'composite-unresolved'])('single Release rejects an absent declared %s entrypoint', (field) => {
    // Arrange
    const f = fixture();
    const relative = field.startsWith('composite') ? 'actions/ci-github-toolchain-verifier/action.yml' : 'actions/ci-jq-provisioner/action.yml';
    const action = yaml.parse(readFileSync(path.join(f.directory, relative), 'utf8'));
    if (field.startsWith('composite')) action.runs.steps[0].run = {
      composite: '"${GITHUB_ACTION_PATH}/../../runtime/missing.sh"',
      'composite-bare': '"$GITHUB_ACTION_PATH/../../runtime/missing.sh"',
      'composite-quoted': '"${GITHUB_ACTION_PATH}"/../../runtime/missing.sh',
      'composite-unresolved': '"${GITHUB_ACTION_PATH}/../../runtime/${SCRIPT_NAME}.sh"',
    }[field];
    else action.runs[field] = 'dist/missing.js';
    f.write(relative, yaml.stringify(action)); f.git('add', '.'); f.git('commit', '-m', 'missing declared entrypoint');
    const sha = f.git('rev-parse', 'HEAD');
    // Act
    const rejectedCandidate = failure(() => planActionReferenceUpdate(f.directory, 'v0.2.11', sha));
    // Assert
    expect(rejectedCandidate).toMatch(/entrypoint/);
    // Arrange
    for (const target of [registryPath, ...repositorySnapshot(f.directory).targets]) {
      f.write(target, readFileSync(path.join(f.directory, target), 'utf8').replaceAll('0'.repeat(40), sha).replace('releaseTag: v0.2.10', 'releaseTag: v0.2.11'));
    }
    f.git('add', '.'); f.git('commit', '-m', 'identical missing entrypoint'); f.git('tag', '-a', 'v0.2.11', '-m', 'invalid source');
    // Act
    const result = spawnSync(process.execPath, [path.join(root, 'runtime/repository/check-provider-references.mjs'), '--contracts', '--release-tag', 'v0.2.11'], { cwd: f.directory, encoding: 'utf8' });
    // Assert
    expect(result.status).toBe(1); expect(JSON.parse(result.stdout).implementationBindingStatus).toBe('rejected');
  });
});
