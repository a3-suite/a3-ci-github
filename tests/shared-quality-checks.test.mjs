import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, test, expect } from 'vitest';
import { parse } from 'yaml';
import { resolvePlatformMatrix, resolveQualityMatrix } from '../actions/ci-platform-matrix/src/matrix.ts';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = parse(fs.readFileSync(path.join(repository, '.github/workflows/ci-quality-platforms.yml'), 'utf8'));
const scopeStep = workflow.jobs.platform.steps.find(step => step.id === 'execution-scope');

describe('shared standard quality checks', () => {
  // contract_id: contract.ci-quality-adapter.outputs
  // flow_id: ci-quality-platforms-shared-execution
  test('only trusted declared standard Rust secondary platforms select native', (t) => {
    // Arrange
    const root = fs.mkdtempSync(path.join(repository, 'tmp/shared-quality-'));
    t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
    const output = path.join(root, 'output');
    const defaults = { TRUSTED_ROOT: '.ci-base', SHARED_STANDARD_CHECKS: 'true', PLATFORM_ID: 'second', FIRST_PLATFORM_ID: 'first',
      CI_STANDARD_BUNDLE_ID: 'rust-cargo-quality', CI_LANGUAGE_PROFILE: 'rust', CI_ADAPTER_DESCRIPTOR: '', GITHUB_OUTPUT: output };
    // Act
    for (const [overrides, expected] of [
      [{}, 'native'], [{ PLATFORM_ID: 'first' }, 'all'], [{ TRUSTED_ROOT: '.' }, 'all'],
      [{ SHARED_STANDARD_CHECKS: '' }, 'all'], [{ SHARED_STANDARD_CHECKS: 'false' }, 'all'],
      [{ CI_STANDARD_BUNDLE_ID: 'python-uv-quality' }, 'all'], [{ CI_LANGUAGE_PROFILE: 'typescript' }, 'all'],
      [{ CI_ADAPTER_DESCRIPTOR: 'custom.yml' }, 'all'], [{ FIRST_PLATFORM_ID: '' }, 'all'],
    ]) {
      fs.writeFileSync(output, '');
      const result = spawnSync('bash', ['-c', scopeStep.run], { env: { ...process.env, ...defaults, ...overrides }, encoding: 'utf8' });
      // Assert
      expect(result.status, result.stderr).toBe(0);
      expect(fs.readFileSync(output, 'utf8')).toBe(`scope=${expected}\n`);
    }
    const adapter = workflow.jobs.platform.steps.find(step => step.id === 'quality-adapter');
    expect(adapter.with['execution-scope']).toBe('${{ steps.execution-scope.outputs.scope }}');
    expect(scopeStep.env.TRUSTED_ROOT).toBe("${{ needs.resolve-platforms.outputs['trusted_root'] }}");
    expect(scopeStep.env.SHARED_STANDARD_CHECKS).toBe('${{ matrix.shared_standard_checks }}');
    expect(scopeStep.env.FIRST_PLATFORM_ID).toBe('${{ fromJSON(needs.resolve-platforms.outputs.matrix).include[0].platform_id }}');
    expect(workflow.jobs.platform.strategy['fail-fast']).toBe(false);
    expect(workflow.jobs['platform-summary'].needs).toStrictEqual(['resolve-platforms', 'platform']);
    expect(adapter.with['toolchain-version']).toBe('${{ env.CI_TOOLCHAIN_VERSION }}');
    expect(workflow.jobs.platform.env.CI_TOOLCHAIN_VERSION).toBe('${{ needs.resolve-platforms.outputs.toolchain-version }}');
  });

  // contract_id: contract.ci-platform-matrix.outputs
  // flow_id: ci-quality-platforms-shared-trust
  test('trusted base declaration wins over head and bootstrap keeps full execution', (t) => {
    // Arrange
    const root = fs.mkdtempSync(path.join(repository, 'tmp/shared-quality-trust-'));
    t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
    const output = path.join(root, 'output');
    const manifest = 'platforms: [{id: linux-x64, runner: ubuntu-24.04, target: x86_64-unknown-linux-gnu}]';
    for (const directory of ['.ci', '.ci-base/.ci']) fs.mkdirSync(path.join(root, directory), { recursive: true });
    for (const prefix of ['', '.ci-base/']) fs.writeFileSync(path.join(root, prefix, '.ci/platform-manifest.yml'), manifest);
    fs.writeFileSync(path.join(root, '.ci/quality-platforms.yml'), 'sharedStandardChecks: true\nplatforms: [{id: linux-x64}]');
    fs.writeFileSync(path.join(root, '.ci-base/.ci/quality-platforms.yml'), 'sharedStandardChecks: false\nplatforms: [{id: linux-x64}]');
    fs.writeFileSync(path.join(root, '.ci-base/.ci/ci-assets.lock.json'), '{}');
    const step = workflow.jobs['resolve-platforms'].steps.find(entry => entry.id === 'trusted-assets');
    const env = { ...process.env, CI_SAME_REPO: 'true', CI_ADAPTER_DESCRIPTOR: '', CI_PLATFORM_MANIFEST: '.ci/platform-manifest.yml',
      CI_QUALITY_PLATFORM_SELECTION: '.ci/quality-platforms.yml', GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: path.join(root, 'summary') };
    // Act
    fs.writeFileSync(output, '');
    const trusted = spawnSync('bash', ['-c', step.run], { cwd: root, env, encoding: 'utf8' });
    const matrix = resolveQualityMatrix(resolvePlatformMatrix(manifest), fs.readFileSync(path.join(root, '.ci-base/.ci/quality-platforms.yml'), 'utf8'));
    // Assert
    expect(trusted.status, trusted.stderr).toBe(0);
    expect(fs.readFileSync(output, 'utf8')).toBe('root=.ci-base\nsource=base\n');
    expect(matrix.matrix.include[0].shared_standard_checks).toBe(false);
    const resolver = workflow.jobs['resolve-platforms'].steps.find(entry => entry.id === 'resolve');
    expect(resolver.with['selection-path']).toBe('${{ steps.trusted-assets.outputs.root }}/${{ env.CI_QUALITY_PLATFORM_SELECTION }}');
    fs.rmSync(path.join(root, '.ci-base'), { recursive: true, force: true });
    fs.writeFileSync(output, '');
    const bootstrap = spawnSync('bash', ['-c', step.run], { cwd: root, env, encoding: 'utf8' });
    expect(bootstrap.status, bootstrap.stderr).toBe(0);
    expect(fs.readFileSync(output, 'utf8')).toBe('root=.\nsource=bootstrap\n');
    fs.writeFileSync(output, '');
    const fork = spawnSync('bash', ['-c', step.run], { cwd: root, env: { ...env, CI_SAME_REPO: 'false' }, encoding: 'utf8' });
    expect(fork.status).not.toBe(0);
    expect(fs.readFileSync(output, 'utf8')).toBe('');
  });
});
