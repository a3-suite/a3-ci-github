import { describe, test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import { root, spawnTimeoutMs, fixture, updateReferences, checkReferences, checkRelease, runScript, failure } from './single-release-binding.fixtures.mjs';

// flow_id: single-release-binding
describe('contract.ci-selective-distribution.publication', () => {
  test('implementation preparation validates existing references without a final tag or new binding', () => {
    const f = fixture();
    updateReferences(f.directory, f.implementation);
    f.git('add', '.'); f.git('commit', '-m', 'existing connection');
    f.write('runtime/payload.mjs', 'export const payload = 2;\n');
    f.git('add', '.');
    const cli = (...args) => spawnSync(process.execPath, [path.join(root, 'runtime/repository/check-provider-references.mjs'), '--staged', '--contracts', ...args], { cwd: f.directory, encoding: 'utf8', timeout: spawnTimeoutMs });

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

  // evidence_role: supplemental
  // The success of the preparation check is not a rejection of the candidate closure that the mapped test observes.
  test('implementation preparation accepts existing references without a final tag or new binding', () => {
    // Arrange
    const f = fixture();
    updateReferences(f.directory, f.implementation);
    f.git('add', '.'); f.git('commit', '-m', 'existing connection');
    f.write('runtime/payload.mjs', 'export const payload = 2;\n');
    f.git('add', '.');
    // Act
    const prepared = spawnSync(process.execPath, [path.join(root, 'runtime/repository/check-provider-references.mjs'), '--staged', '--contracts', '--preparation'], { cwd: f.directory, encoding: 'utf8', timeout: spawnTimeoutMs });
    // Assert
    expect(prepared.status, prepared.stderr).toBe(0);
    const report = JSON.parse(prepared.stdout);
    expect(report).toMatchObject({ preparationOnly: true, implementationBindingStatus: 'unverified', implementationSourceRevision: f.implementation });
    expect(report.connection.diagnostics).toEqual([]);
  });

  // evidence_role: supplemental
  // Creating no tag is a side effect of the preparation check, not an observation of the binding guarantee.
  test('implementation preparation creates no tag', () => {
    const f = fixture();
    updateReferences(f.directory, f.implementation);
    f.git('add', '.'); f.git('commit', '-m', 'existing connection');
    f.write('runtime/payload.mjs', 'export const payload = 2;\n');
    f.git('add', '.');
    const prepared = spawnSync(process.execPath, [path.join(root, 'runtime/repository/check-provider-references.mjs'), '--staged', '--contracts', '--preparation'], { cwd: f.directory, encoding: 'utf8', timeout: spawnTimeoutMs });
    expect(prepared.status, prepared.stderr).toBe(0);
    expect(f.git('tag', '--list')).toBe('');
  });

  // evidence_role: supplemental
  // The absent tag, the tag list after verification, the empty changed paths and the GITHUB_OUTPUT content are side effects of the connection, not observations of the binding guarantee.
  test.each(['release/0.2.11', 'hotfix/0.2.11'])('one Release connection creates no tag before the release, changes nothing on repeat and writes the gate output on %s', (branch) => {
    const f = fixture(); f.git('switch', '-c', branch);
    updateReferences(f.directory, f.implementation, '--check');
    expect(f.git('tag', '--list')).toBe('');
    updateReferences(f.directory, f.implementation);
    const repeated = runScript('update-action-references.mjs', f.directory, ['--check', '--tag', 'v0.2.11', '--implementation-sha', f.implementation]);
    expect(JSON.parse(repeated.stdout).changedPaths).toEqual([]);
    f.git('add', '.'); f.git('commit', '-m', 'connect implementation'); f.git('tag', '-a', 'v0.2.11', '-m', 'single release');
    runScript('check-provider-references.mjs', f.directory, ['--contracts', '--release-tag', 'v0.2.11']);
    expect(f.git('tag', '--list')).toBe('v0.2.11');
    const workflow = yaml.parse(readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8'));
    const gate = workflow.jobs['prepare-distribution'].steps.find((step) => step.id === 'provider-binding');
    const script = gate.run.replace('node runtime/repository/check-provider-references.mjs', `node "${path.join(root, 'runtime/repository/check-provider-references.mjs')}"`);
    const output = path.join(f.directory, 'tmp/binding-output'); f.write('tmp/binding-output', '');
    const runGate = () => spawnSync('bash', ['-c', script], { cwd: f.directory, encoding: 'utf8', env: { ...process.env, RELEASE_TAG: 'v0.2.11', GITHUB_OUTPUT: output }, timeout: spawnTimeoutMs });
    expect(runGate().status).toBe(0);
    expect(readFileSync(output, 'utf8')).toBe(`implementation_source_sha=${f.implementation}\nimplementation_binding_status=verified\n`);
    f.write('runtime/payload.mjs', 'export const payload = 2;\n'); f.write('tmp/binding-output', '');
    runGate();
    expect(readFileSync(output, 'utf8')).toBe('');
  });

  test.each(['release/0.2.11', 'hotfix/0.2.11'])('one Release connects an untagged implementation on %s', (branch) => {
    // Arrange
    const f = fixture(); f.git('switch', '-c', branch);
    // Act
    const plan = updateReferences(f.directory, f.implementation, '--check');
    // Assert
    expect(plan.connection.diagnostics).toEqual([]);
    // Act
    updateReferences(f.directory, f.implementation);
    const repeated = runScript('update-action-references.mjs', f.directory, ['--check', '--tag', 'v0.2.11', '--implementation-sha', f.implementation]);
    // Assert
    expect(repeated.status, repeated.stderr).toBe(0);
    // Arrange
    f.git('add', '.');
    // Act
    const candidate = checkReferences(f.directory, '--staged', '--candidate');
    // Assert
    expect(candidate.implementationBindingStatus).toBe('verified');
    // Arrange
    f.git('add', '.'); f.git('commit', '-m', 'connect implementation'); f.git('tag', '-a', 'v0.2.11', '-m', 'single release');
    // Act
    const executed = runScript('check-provider-references.mjs', f.directory, ['--contracts', '--release-tag', 'v0.2.11']);
    // Assert
    expect(executed.status, executed.stderr).toBe(0);
    const checked = JSON.parse(executed.stdout);
    expect(checked.diagnostics).toEqual([]); expect(checked.connection.diagnostics).toEqual([]);
    expect(checked.implementationBindingStatus).toBe('verified');
    expect(checked.implementationBinding).toMatchObject({
      implementationSourceRevision: f.implementation,
      sourceRevision: f.git('rev-parse', 'refs/tags/v0.2.11^{commit}'),
    });
    expect(checked.implementationBinding.checkedObjects).toContainEqual({
      path: 'runtime/payload.mjs',
      implementationObject: f.git('rev-parse', `${f.implementation}:runtime/payload.mjs`),
      sourceObject: f.git('rev-parse', 'refs/tags/v0.2.11:runtime/payload.mjs'),
    });
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
    // Arrange
    f.write('runtime/payload.mjs', 'export const payload = 2;\n'); f.write('tmp/binding-output', '');
    // Act
    const rejectedGate = runGate();
    // Assert
    expect(rejectedGate.error).toBeUndefined();
    expect(rejectedGate.status).not.toBe(0);
    expect(rejectedGate.stderr).toContain('implementation-publication-source-dirty');
  });

  // evidence_role: supplemental
  // The unverified status of a check without contracts is not a verified, evidence or rejected observation of the binding guarantee.
  test('a check without contracts reports the implementation binding as unverified', () => {
    // Arrange
    const f = fixture(); f.git('switch', '-c', 'release/0.2.11');
    updateReferences(f.directory, f.implementation);
    f.git('add', '.'); f.git('commit', '-m', 'connect implementation'); f.git('tag', '-a', 'v0.2.11', '-m', 'single release');
    // Act
    const metadataOnly = runScript('check-provider-references.mjs', f.directory, []);
    // Assert
    expect(metadataOnly.status).toBe(0); expect(JSON.parse(metadataOnly.stdout).implementationBindingStatus).toBe('unverified');
  });

  test('one Release verifies a squashed main tag by execution closure while the implementation stays reachable', () => {
    // Arrange
    const f = fixture(); const base = f.git('rev-parse', `${f.implementation}^`);
    f.git('switch', '-c', 'release/0.2.11');
    updateReferences(f.directory, f.implementation);
    f.git('add', '.'); f.git('commit', '-m', 'connect implementation');
    const squashed = f.git('commit-tree', f.git('rev-parse', 'HEAD^{tree}'), '-p', base, '-m', 'squash release');
    f.git('switch', 'main'); f.git('reset', '--hard', squashed); f.git('tag', '-a', 'v0.2.11', '-m', 'single release');
    // Act
    const checked = checkRelease(f.directory);
    // Assert
    expect(spawnSync('git', ['merge-base', '--is-ancestor', f.implementation, 'HEAD'], { cwd: f.directory, timeout: spawnTimeoutMs }).status).toBe(1);
    expect(checked.diagnostics).toEqual([]); expect(checked.implementationBindingStatus).toBe('verified');
    expect(checked.implementationBinding).toMatchObject({ implementationSourceRevision: f.implementation, sourceRevision: squashed });
    expect(checked.implementationBinding.checkedObjects.map((entry) => entry.path)).toContain('runtime/payload.mjs');
    for (const entry of checked.implementationBinding.checkedObjects) {
      expect(entry.implementationObject).toBe(f.git('rev-parse', `${f.implementation}:${entry.path}`));
      expect(entry.sourceObject).toBe(f.git('rev-parse', `${squashed}:${entry.path}`));
    }
    // Arrange
    const released = f.git('rev-parse', 'release/0.2.11');
    f.git('branch', '-D', 'release/0.2.11'); f.git('update-ref', 'refs/remotes/pull/1/merge', released);
    // Act
    const unreachable = failure(() => checkRelease(f.directory));
    // Assert
    expect(unreachable).toMatch(/implementation-source-unreachable/);
  });

  // evidence_role: supplemental
  // The source revision that preparation reports is not a verified, evidence or rejected observation of the binding guarantee.
  test('preparation after a squashed main tag accepts the reachable implementation outside its ancestry', () => {
    // Arrange
    const f = fixture(); const base = f.git('rev-parse', `${f.implementation}^`);
    f.git('switch', '-c', 'release/0.2.11');
    updateReferences(f.directory, f.implementation);
    f.git('add', '.'); f.git('commit', '-m', 'connect implementation');
    const squashed = f.git('commit-tree', f.git('rev-parse', 'HEAD^{tree}'), '-p', base, '-m', 'squash release');
    f.git('switch', 'main'); f.git('reset', '--hard', squashed); f.git('tag', '-a', 'v0.2.11', '-m', 'single release');
    // Act
    const prepared = checkReferences(f.directory, '--preparation');
    // Assert
    // A hotfix branches from this tag, so preparation must accept the reachable implementation outside its ancestry.
    expect(prepared.implementationSourceRevision).toBe(f.implementation);
  });
});
