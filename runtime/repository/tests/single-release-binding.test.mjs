import { describe, test, expect, onTestFinished, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';
import { checkRepository, repositorySnapshot, registryPath } from '../check-provider-references.mjs';
import { planActionReferenceUpdate, applyActionReferenceUpdate } from '../update-action-references.mjs';
import { providerMaintenanceRuntime } from '../verify-implementation-binding.mjs';
// Synchronous child processes block the worker, so Vitest's testTimeout cannot interrupt them; bound each call.
// Calls take up to 1.7s alone but over 7s under full-regression load; the limit is about 5x that load maximum.
// A timeout means the call regressed: investigate its performance or split it before raising the limit.
const spawnTimeoutMs = 35000;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const failure = (operation) => { try { operation(); } catch (error) { return error.message; } };
const access = (directory) => ({
  directory,
  git: (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: 'pipe', timeout: spawnTimeoutMs }).trim(),
  write: (relative, bytes) => { mkdirSync(path.dirname(path.join(directory, relative)), { recursive: true }); writeFileSync(path.join(directory, relative), bytes); },
});
let seed;
let implementation;
beforeAll(() => {
  mkdirSync(path.join(root, 'tmp'), { recursive: true });
  seed = mkdtempSync(path.join(root, 'tmp/single-release-binding-seed-'));
  const { git, write } = access(seed);
  git('init', '-b', 'main'); git('config', 'user.name', 'Binding Test'); git('config', 'user.email', 'binding@example.invalid'); git('config', 'commit.gpgsign', 'false'); git('config', 'core.autocrlf', 'false');
  const zero = '0'.repeat(40);
  const registry = yaml.parse(readFileSync(path.join(root, registryPath), 'utf8'));
  registry.actionization.implementationSource = { repository: 'a3-suite/a3-ci-github', releaseTag: 'v0.2.10', exactRef: zero };
  const steps = ['ci-quality-adapter', 'ci-release-publication-control', 'ci-jq-provisioner', 'ci-github-toolchain-verifier'].map((name) => {
    const actionPath = `actions/${name}`;
    const action = yaml.parse(readFileSync(path.join(root, actionPath, 'action.yml'), 'utf8'));
    write(`${actionPath}/action.yml`, readFileSync(path.join(root, actionPath, 'action.yml')));
    if (action.runs.main) {
      write(`${actionPath}/${action.runs.main}`, readFileSync(path.join(root, actionPath, action.runs.main)));
      // The ESM dist runs only with the module scope that ncc writes beside it.
      const scope = path.posix.join(path.posix.dirname(action.runs.main), 'package.json');
      if (existsSync(path.join(root, actionPath, scope))) write(`${actionPath}/${scope}`, readFileSync(path.join(root, actionPath, scope)));
    }
    return { uses: `a3-suite/a3-ci-github/${actionPath}@${zero}`, env: { A3_INSTALLER_PROVIDER_REVISION: zero }, with: Object.fromEntries(Object.entries(action.inputs).filter(([, value]) => value.required && !Object.hasOwn(value, 'default')).map(([key]) => [key, 'fixed'])) };
  });
  write(registryPath, yaml.stringify(registry)); write('VERSION', '0.2.10\n'); write('runtime/payload.mjs', 'export const payload = 1;\n');
  write('runtime/github-toolchain/verify-github-toolchain.sh', readFileSync(path.join(root, 'runtime/github-toolchain/verify-github-toolchain.sh')));
  write('actions/ci-quality-adapter/scripts/composite.sh', '#!/bin/sh\nexit 0\n');
  for (const name of ['ci-quality', 'ci-quality-platforms', 'ci-package-preparation', 'ci-release-publication', 'ci-package-publication']) write(`.github/workflows/${name}.yml`, yaml.stringify({ jobs: { checked: { steps } } }));
  git('add', '.'); git('commit', '-m', 'base');
  write('VERSION', '0.2.11\n'); git('add', '.'); git('commit', '-m', 'implementation');
  implementation = git('rev-parse', 'HEAD');
});
afterAll(() => { if (seed) rmSync(seed, { recursive: true, force: true }); });
const fixture = () => {
  const directory = mkdtempSync(path.join(root, 'tmp/single-release-binding-'));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  // Copy the index, refs and objects too: each case mutates a fully isolated real repository.
  cpSync(seed, directory, { recursive: true });
  return { ...access(directory), implementation };
};

// flow_id: single-release-binding
describe('contract.ci-selective-distribution.publication', () => {
  test('implementation preparation validates existing references without a final tag or new binding', () => {
    const f = fixture();
    applyActionReferenceUpdate(f.directory, planActionReferenceUpdate(f.directory, 'v0.2.11', f.implementation));
    f.git('add', '.'); f.git('commit', '-m', 'existing connection');
    f.write('runtime/payload.mjs', 'export const payload = 2;\n');
    f.git('add', '.');
    const cli = (...args) => spawnSync(process.execPath, [path.join(root, 'runtime/repository/check-provider-references.mjs'), '--staged', '--contracts', ...args], { cwd: f.directory, encoding: 'utf8', timeout: spawnTimeoutMs });

    const prepared = cli('--preparation');
    expect(prepared.status, prepared.stderr).toBe(0);
    const report = JSON.parse(prepared.stdout);
    expect(report).toMatchObject({ preparationOnly: true, implementationBindingStatus: 'unverified', implementationSourceRevision: f.implementation });
    expect(report.connection.diagnostics).toEqual([]);
    expect(f.git('tag', '--list')).toBe('');
    const candidate = cli('--candidate');
    expect(candidate.error).toBeUndefined();
    expect(candidate.status).not.toBe(0);
    expect(candidate.stderr).toContain('implementation-execution-closure-mismatch');

    const relative = '.github/workflows/ci-quality.yml';
    const workflow = yaml.parse(readFileSync(path.join(f.directory, relative), 'utf8'));
    workflow.jobs.checked.steps[0].with['undeclared-input'] = 'invalid';
    f.write(relative, yaml.stringify(workflow)); f.git('add', '.');
    const invalidInterface = cli('--preparation');
    expect(invalidInterface.status).toBe(1);
    expect(JSON.parse(invalidInterface.stdout).interfaceDiagnostics).toContainEqual(expect.stringContaining('undeclared-input'));
    expect(JSON.parse(invalidInterface.stdout).preparationOnly).toBe(false);

    workflow.jobs.checked.steps.push({ uses: `actions/checkout@${'f'.repeat(40)}` });
    f.write(relative, yaml.stringify(workflow)); f.git('add', '.');
    const invalidPin = cli('--preparation');
    expect(invalidPin.status).toBe(1);
    expect(JSON.parse(invalidPin.stdout).diagnostics).toContainEqual(expect.stringContaining('registry-approved provider pin'));
  });

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
    const executed = spawnSync(process.execPath, [path.join(root, 'runtime/repository/check-provider-references.mjs'), '--contracts', '--release-tag', 'v0.2.11'], { cwd: f.directory, encoding: 'utf8', timeout: spawnTimeoutMs });
    const metadataOnly = spawnSync(process.execPath, [path.join(root, 'runtime/repository/check-provider-references.mjs')], { cwd: f.directory, encoding: 'utf8', timeout: spawnTimeoutMs });
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
    const runGate = () => spawnSync('bash', ['-c', script], { cwd: f.directory, encoding: 'utf8', env: { ...process.env, RELEASE_TAG: 'v0.2.11', GITHUB_OUTPUT: output }, timeout: spawnTimeoutMs });
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
    expect(rejectedGate.error).toBeUndefined();
    expect(rejectedGate.status).not.toBe(0); expect(readFileSync(output, 'utf8')).toBe('');
  });

  test('one Release verifies a squashed main tag by execution closure while the implementation stays reachable', () => {
    // Arrange
    const f = fixture(); const base = f.git('rev-parse', `${f.implementation}^`);
    f.git('switch', '-c', 'release/0.2.11');
    applyActionReferenceUpdate(f.directory, planActionReferenceUpdate(f.directory, 'v0.2.11', f.implementation));
    f.git('add', '.'); f.git('commit', '-m', 'connect implementation');
    const squashed = f.git('commit-tree', f.git('rev-parse', 'HEAD^{tree}'), '-p', base, '-m', 'squash release');
    f.git('switch', 'main'); f.git('reset', '--hard', squashed); f.git('tag', '-a', 'v0.2.11', '-m', 'single release');
    // Act
    const checked = checkRepository(f.directory, false, { releaseTag: 'v0.2.11' });
    // Assert
    expect(spawnSync('git', ['merge-base', '--is-ancestor', f.implementation, 'HEAD'], { cwd: f.directory, timeout: spawnTimeoutMs }).status).toBe(1);
    expect(checked.diagnostics).toEqual([]); expect(checked.implementationBinding.implementationBindingStatus).toBe('verified');
    expect(checked.implementationBinding).toMatchObject({ implementationSourceRevision: f.implementation, sourceRevision: squashed });
    expect(checked.implementationBinding.checkedObjects.map((entry) => entry.path)).toContain('runtime/payload.mjs');
    for (const entry of checked.implementationBinding.checkedObjects) {
      expect(entry.implementationObject).toBe(f.git('rev-parse', `${f.implementation}:${entry.path}`));
      expect(entry.sourceObject).toBe(f.git('rev-parse', `${squashed}:${entry.path}`));
    }
    // A hotfix branches from this tag, so preparation must accept the reachable implementation outside its ancestry.
    expect(checkRepository(f.directory, false, { preparation: true }).implementationBinding.implementationSourceRevision).toBe(f.implementation);
    // Arrange
    const released = f.git('rev-parse', 'release/0.2.11');
    f.git('branch', '-D', 'release/0.2.11'); f.git('update-ref', 'refs/remotes/pull/1/merge', released);
    // Act
    const unreachable = failure(() => checkRepository(f.directory, false, { releaseTag: 'v0.2.11' }));
    // Assert
    expect(unreachable).toMatch(/implementation-source-unreachable/);
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

  test.each(['runtime/preset/payload.mjs', 'runtime/distribution/payload.mjs', 'runtime/repository/payload.mjs', 'runtime/vitest/payload.mjs'])('single Release accepts changed provider maintenance runtime %s', (relative) => {
    // Arrange
    const f = fixture(); applyActionReferenceUpdate(f.directory, planActionReferenceUpdate(f.directory, 'v0.2.11', f.implementation));
    f.write(relative, 'export const payload = 2;\n');
    f.git('add', '.'); f.git('commit', '-m', 'provider maintenance change'); f.git('tag', '-a', 'v0.2.11', '-m', 'maintenance source');
    // Act
    const checked = checkRepository(f.directory, false, { releaseTag: 'v0.2.11' });
    // Assert
    expect(checked.implementationBinding.implementationBindingStatus).toBe('verified');
    expect(checked.implementationBinding.checkedObjects.map((entry) => entry.path)).not.toContain(path.posix.dirname(relative));
  });

  test('single Release rejects a runtime entry added outside provider maintenance', () => {
    // Arrange
    const f = fixture(); applyActionReferenceUpdate(f.directory, planActionReferenceUpdate(f.directory, 'v0.2.11', f.implementation));
    f.write('runtime/added/payload.mjs', 'export const payload = 1;\n');
    f.git('add', '.'); f.git('commit', '-m', 'added runtime'); f.git('tag', '-a', 'v0.2.11', '-m', 'added runtime');
    // Act
    const rejected = failure(() => checkRepository(f.directory, false, { releaseTag: 'v0.2.11' }));
    // Assert
    expect(rejected).toMatch(/closure-mismatch: runtime\/added/);
  });

  test('pinned Actions and canonical workflows never reach provider maintenance runtime', () => {
    // Arrange
    // The generator runs at build time only; Actions execute its committed output.
    const buildTimeOnly = ['runtime/adapter/generate-standard-quality-bundles.mjs'];
    const executed = execFileSync('git', ['ls-files', '--', 'actions', 'runtime', '.github/workflows/ci-*.yml', 'workflows', ...providerMaintenanceRuntime.map((directory) => `:(exclude)${directory}`)], { cwd: root, encoding: 'utf8' })
      .split('\n').filter((relative) => relative && !/(^|\/)(tests?|node_modules)\//.test(relative) && !/\.(md|lock)$/.test(relative));
    const names = providerMaintenanceRuntime.map((directory) => path.posix.basename(directory)).join('|');
    // Slash-joined paths and segment lists such as path.join(root, 'runtime', 'preset') both count as references.
    const reference = new RegExp(`(runtime(/|['"]\\s*,\\s*['"])|\\.\\./)(${names})(/|['"])|['"/](${buildTimeOnly.map((relative) => path.posix.basename(relative)).join('|')})`);
    // Act
    const reaching = executed.filter((relative) => !buildTimeOnly.includes(relative) && reference.test(readFileSync(path.join(root, relative), 'utf8')));
    // Assert
    expect(reaching).toEqual([]);
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
    expect(missingArgument).toMatch(/full implementation/); expect(missingObject).toBeDefined(); expect(unrelatedObject).toMatch(/unreachable/);
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

  // runtime/payload.mjs is a top-level runtime blob, whose id alone does not record the mode.
  test.each(['actions/ci-quality-adapter/scripts/composite.sh', 'runtime/payload.mjs'])('single Release rejects a changed execution file mode of %s', (relative) => {
    // Arrange
    const f = fixture(); applyActionReferenceUpdate(f.directory, planActionReferenceUpdate(f.directory, 'v0.2.11', f.implementation));
    chmodSync(path.join(f.directory, relative), 0o755);
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
      const result = spawnSync(process.execPath, [path.join(root, 'runtime/repository/check-provider-references.mjs'), '--contracts', '--release-tag', 'v0.2.11'], { cwd: f.directory, encoding: 'utf8', timeout: spawnTimeoutMs });
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
    expect(rejectedCandidate).toMatch(/action-contract-execution-unavailable/);
    // Arrange
    for (const relative of [registryPath, ...repositorySnapshot(f.directory).targets]) {
      f.write(relative, readFileSync(path.join(f.directory, relative), 'utf8').replaceAll('0'.repeat(40), sha).replace('releaseTag: v0.2.10', 'releaseTag: v0.2.11'));
    }
    f.git('add', '.'); f.git('commit', '-m', 'broken binding'); f.git('tag', '-a', 'v0.2.11', '-m', 'invalid behavior');
    const cli = (...args) => spawnSync(process.execPath, [path.join(root, 'runtime/repository/check-provider-references.mjs'), ...args], { cwd: f.directory, encoding: 'utf8', timeout: spawnTimeoutMs });
    // Act
    const result = cli('--contracts', '--release-tag', 'v0.2.11');
    const bypass = cli('--release-tag', 'v0.2.11');
    // Assert
    expect(result.status).toBe(2); expect(result.stderr).toContain('action-contract-execution-unavailable');
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
    const result = spawnSync(process.execPath, [path.join(root, 'runtime/repository/check-provider-references.mjs'), '--contracts', '--release-tag', 'v0.2.11'], { cwd: f.directory, encoding: 'utf8', timeout: spawnTimeoutMs });
    // Assert
    expect(result.status).toBe(1); expect(JSON.parse(result.stdout).implementationBindingStatus).toBe('rejected');
  });
});
