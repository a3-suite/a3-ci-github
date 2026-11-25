import { describe, test, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, readFileSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import { repositorySnapshot, registryPath } from '../check-provider-references.mjs';
import { planActionReferenceUpdate, applyActionReferenceUpdate } from '../update-action-references.mjs';
import { providerMaintenanceRuntime } from '../verify-implementation-binding.mjs';
import { root, spawnTimeoutMs, failure, fixture, runScript, updateReferences, checkRelease } from './single-release-binding.fixtures.mjs';

// flow_id: single-release-binding
describe('contract.ci-selective-distribution.publication', () => {
  test.each(['VERSION', 'runtime/payload.mjs', 'actions/ci-quality-adapter/action.yml', 'actions/ci-quality-adapter/dist/index.js', 'actions/ci-quality-adapter/scripts/composite.sh'])('single Release rejects changed execution input %s', (relative) => {
    // Arrange
    const f = fixture(); updateReferences(f.directory, f.implementation);
    f.write(relative, relative === 'VERSION' ? '0.2.12\n' : `${readFileSync(path.join(f.directory, relative), 'utf8')}\n`);
    f.git('add', '.'); f.git('commit', '-m', 'invalid final source'); f.git('tag', '-a', 'v0.2.11', '-m', 'invalid source');
    // Act
    const rejected = failure(() => checkRelease(f.directory));
    // Assert
    expect(rejected).toMatch(/version-mismatch|closure-mismatch/);
  });

  test.each(['runtime/preset/payload.mjs', 'runtime/distribution/payload.mjs', 'runtime/repository/payload.mjs', 'runtime/vitest/payload.mjs'])('single Release accepts changed provider maintenance runtime %s', (relative) => {
    // Arrange
    const f = fixture(); updateReferences(f.directory, f.implementation);
    f.write(relative, 'export const payload = 2;\n');
    f.git('add', '.'); f.git('commit', '-m', 'provider maintenance change'); f.git('tag', '-a', 'v0.2.11', '-m', 'maintenance source');
    // Act
    const checked = checkRelease(f.directory);
    // Assert
    expect(checked.implementationBindingStatus).toBe('verified');
    expect(checked.implementationBinding.checkedObjects.map((entry) => entry.path)).not.toContain(path.posix.dirname(relative));
  });

  test('single Release rejects a runtime entry added outside provider maintenance', () => {
    // Arrange
    const f = fixture(); updateReferences(f.directory, f.implementation);
    f.write('runtime/added/payload.mjs', 'export const payload = 1;\n');
    f.git('add', '.'); f.git('commit', '-m', 'added runtime'); f.git('tag', '-a', 'v0.2.11', '-m', 'added runtime');
    // Act
    const rejected = failure(() => checkRelease(f.directory));
    // Assert
    expect(rejected).toMatch(/"reason":"implementation-execution-closure-mismatch"/); expect(rejected).toMatch(/"path":"runtime\/added"/);
  });

  // evidence_role: supplemental
  // Scans repository files statically; it does not invoke a provider reference command.
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
    const registryBefore = readFileSync(path.join(f.directory, registryPath), 'utf8');
    const missingArgument = failure(() => updateReferences(f.directory, ''));
    const missingObject = failure(() => updateReferences(f.directory, 'f'.repeat(40)));
    const unrelatedObject = failure(() => updateReferences(f.directory, unrelated));
    // Assert
    expect(missingArgument).toMatch(/^ci-failure-diagnostic:.*"classification":\{[^}]*"stage":"input-validation"/m);
    expect(missingArgument).toMatch(/"reason":"action-reference-sha-invalid"/);
    expect(missingObject).toMatch(/"stage":"implementation-binding"/);
    expect(missingObject).toMatch(/implementation-binding-commit-required/);
    expect(unrelatedObject).toMatch(/"stage":"implementation-binding"/);
    expect(unrelatedObject).toMatch(/implementation-source-unreachable/);
    expect(readFileSync(path.join(f.directory, registryPath), 'utf8')).toBe(registryBefore);
  });

  // evidence_role: supplemental
  // A change between planning and writing cannot be produced through one CLI run, so the module boundary is exercised directly.
  test('reference application rejects a registry changed after planning and preserves approval inputs', () => {
    // Arrange
    const f = fixture();
    const plan = planActionReferenceUpdate(f.directory, 'v0.2.11', f.implementation);
    f.write(registryPath, `${plan.before.get(registryPath)}\n# changed after plan\n`);
    // Act
    const changedInput = failure(() => applyActionReferenceUpdate(f.directory, plan));
    // Assert
    expect(changedInput).toMatch(/input changed/);
    expect(repositorySnapshot(f.directory).registry.actionization.implementationSource.exactRef).toBe('0'.repeat(40));
  });

  test('candidate application rejects closure changes without writing references', () => {
    // Arrange
    const f = fixture(); const registryBefore = readFileSync(path.join(f.directory, registryPath), 'utf8');
    f.write('runtime/payload.mjs', 'export const payload = 2;\n');
    // Act
    const changedClosure = failure(() => updateReferences(f.directory, f.implementation));
    // Assert
    expect(changedClosure).toMatch(/execution-assets-dirty/);
    expect(readFileSync(path.join(f.directory, registryPath), 'utf8')).toBe(registryBefore);
  });

  test('candidate application rejects symlink destinations without writing references', () => {
    // Arrange
    const f = fixture(); const registryBefore = readFileSync(path.join(f.directory, registryPath), 'utf8');
    f.write('registry-copy.yml', registryBefore); unlinkSync(path.join(f.directory, registryPath));
    symlinkSync(path.join(f.directory, 'registry-copy.yml'), path.join(f.directory, registryPath));
    // Act
    const redirected = failure(() => updateReferences(f.directory, f.implementation));
    // Assert
    expect(redirected).toMatch(/"reason":"action-reference-symlink-rejected"/);
    expect(readlinkSync(path.join(f.directory, registryPath))).toBe(path.join(f.directory, 'registry-copy.yml'));
    expect(readFileSync(path.join(f.directory, 'registry-copy.yml'), 'utf8')).toBe(registryBefore);
  });

  // runtime/payload.mjs is a top-level runtime blob, whose id alone does not record the mode.
  test.each(['actions/ci-quality-adapter/scripts/composite.sh', 'runtime/payload.mjs'])('single Release rejects a changed execution file mode of %s', (relative) => {
    // Arrange
    const f = fixture(); updateReferences(f.directory, f.implementation);
    chmodSync(path.join(f.directory, relative), 0o755);
    f.git('add', '.'); f.git('commit', '-m', 'change execution mode'); f.git('tag', '-a', 'v0.2.11', '-m', 'invalid closure');
    // Act
    const rejected = failure(() => checkRelease(f.directory));
    // Assert
    expect(rejected).toMatch(/closure-mismatch/);
  });

  test('single Release rejects stale workflow and installer bindings and invalid interfaces', () => {
    for (const mismatch of ['workflow', 'installer', 'interface']) {
      // Arrange
      const f = fixture(); updateReferences(f.directory, f.implementation);
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
      expect(result.stderr).toMatch(/"stage":"repository-binding"/);
    }
  });

  test('provider reference check identifies invalid arguments before repository binding', () => {
    const f = fixture();
    const result = runScript('check-provider-references.mjs', f.directory, ['--unbound-option']);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/"stage":"input-validation","reason":"provider-reference-arguments-invalid"/);
  });

  test('single Release cannot validate an unexecutable fixed bundle or bypass execution checks', () => {
    // Arrange
    const f = fixture(); f.write('actions/ci-quality-adapter/dist/index.js', 'const = ;'); f.git('add', '.'); f.git('commit', '-m', 'broken implementation');
    const sha = f.git('rev-parse', 'HEAD');
    // Act
    const rejectedCandidate = failure(() => updateReferences(f.directory, sha, '--check'));
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
    const rejectedCandidate = failure(() => updateReferences(f.directory, sha, '--check'));
    // Assert
    expect(rejectedCandidate).toMatch(/"reason":"action-reference-contract-rejected"/);
    // Arrange
    for (const target of [registryPath, ...repositorySnapshot(f.directory).targets]) {
      f.write(target, readFileSync(path.join(f.directory, target), 'utf8').replaceAll('0'.repeat(40), sha).replace('releaseTag: v0.2.10', 'releaseTag: v0.2.11'));
    }
    f.git('add', '.'); f.git('commit', '-m', 'identical missing entrypoint'); f.git('tag', '-a', 'v0.2.11', '-m', 'invalid source');
    // Act
    const result = spawnSync(process.execPath, [path.join(root, 'runtime/repository/check-provider-references.mjs'), '--contracts', '--release-tag', 'v0.2.11'], { cwd: f.directory, encoding: 'utf8', timeout: spawnTimeoutMs });
    // Assert
    expect(result.status).toBe(1); expect(JSON.parse(result.stdout).implementationBindingStatus).toBe('rejected');
    expect(result.stderr).toMatch(/^ci-failure-diagnostic:.*"classification":\{[^}]*"stage":"repository-binding"/m);
  });
});
