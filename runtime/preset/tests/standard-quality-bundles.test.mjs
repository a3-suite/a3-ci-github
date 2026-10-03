import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { loadRegistry } from '../preset-registry.ts';
import { managedAssets } from '../ci-preset-assets.ts';
import { validateQualityPreset } from '../quality-validation.ts';
import { createReport } from '../validation-report.ts';
import { validateCiPreset } from '../validate-ci-preset.ts';
import { snapshotTree } from './support/release-request-fixture.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const yaml = createRequire(path.join(repository, 'runtime/preset/package.json'))('yaml');

// integration_id: preset-assurance-contract
// contract_id: contract.ci-preset-assurance.verification
// evidence_role: contract
// test_level: integration
test('preflight validates fixed standard quality bundles without a descriptor or external owner checkout', () => {
  const root = fs.mkdtempSync(path.join(repository, 'tmp/standard-quality-preflight-'));
  try {
    const report = createReport();
    const registry = loadRegistry(report);
    const preset = registry.presets.find((entry) => entry.id === 'quality-gate');
    const workflowPath = preset.workflowAssets[0].destination;
    fs.mkdirSync(path.dirname(path.join(root, workflowPath)), { recursive: true });
    for (const [profile, id] of [['rust', 'rust-cargo-quality'], ['python', 'python-uv-quality'], ['typescript', 'typescript-npm-quality']]) {
      const workflow = { env: { CI_LANGUAGE_PROFILE: profile, CI_TOOLCHAIN_VERSION: '1.2.3', CI_UV_VERSION: '1.2.3', CI_CARGO_AUDIT_VERSION: '1.2.3',
        CI_CARGO_MANIFEST_PATH: 'Cargo.toml', CI_CARGO_LOCK_PATH: 'Cargo.lock', CI_STANDARD_BUNDLE_ID: id, CI_ADAPTER_DESCRIPTOR: '' },
        jobs: { quality: { steps: [{ uses: `${registry.actionRepository}/actions/ci-quality-adapter@${registry.pendingActionRef}`, with: { 'standard-bundle-id': '${{ env.CI_STANDARD_BUNDLE_ID }}' } }] } } };
      fs.writeFileSync(path.join(root, 'Cargo.toml'), '\n'); fs.writeFileSync(path.join(root, 'Cargo.lock'), '\n');
      fs.writeFileSync(path.join(root, 'pyproject.toml'), '\n'); fs.writeFileSync(path.join(root, 'uv.lock'), '\n');
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: Object.fromEntries(['format:check', 'lint', 'typecheck', 'test'].map((name) => [name, 'node --version'])) }));
      fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
      fs.writeFileSync(path.join(root, workflowPath), yaml.stringify(workflow));
      const context = { root, registry, report: createReport(), parsed: new Map([[workflowPath, workflow]]) };
      validateQualityPreset(context, preset);
      assert.deepEqual(context.report.missingSettings, []);
      assert.deepEqual(context.report.mismatches, []);
      assert.deepEqual(managedAssets(root, registry, [preset]).map((asset) => asset.path), [workflowPath]);
      assert.equal(fs.existsSync(path.join(root, '.ci/adapters')), false);
      for (const mutation of [
        (value) => { value.env.CI_STANDARD_BUNDLE_ID = 'unknown'; },
        (value) => { value.env.CI_STANDARD_BUNDLE_ID = 123; },
        (value) => { value.env.CI_ADAPTER_DESCRIPTOR = '.ci/adapters/override.yml'; },
        (value) => { value.jobs.quality.steps[0].with['standard-bundle-id'] = '${{ github.event.pull_request.head.sha }}'; },
        (value) => { value.jobs.quality.steps[0].with['bundle-path'] = '.ci/adapters/override.yml'; },
        (value) => { value.jobs.quality.steps = []; },
      ]) {
        const changed = structuredClone(workflow); mutation(changed);
        fs.writeFileSync(path.join(root, workflowPath), yaml.stringify(changed));
        const rejected = { ...context, report: createReport() };
        validateQualityPreset(rejected, preset);
        assert.ok(rejected.report.mismatches.length > 0);
      }
      for (const mutation of [
        (value) => { value.env.CI_UV_VERSION = ''; value.env.CI_CARGO_AUDIT_VERSION = ''; },
        (value) => { delete value.env.CI_STANDARD_BUNDLE_ID; delete value.env.CI_ADAPTER_DESCRIPTOR; },
      ]) {
        // Arrange
        const changed = structuredClone(workflow);
        mutation(changed);
        fs.writeFileSync(path.join(root, workflowPath), yaml.stringify(changed));
        const rejected = { ...context, report: createReport() };
        // Act
        validateQualityPreset(rejected, preset);
        // Assert
        if (profile !== 'typescript' || changed.env.CI_STANDARD_BUNDLE_ID === undefined) {
          assert.ok(rejected.report.missingSettings.length > 0);
        } else {
          assert.deepEqual(rejected.report.missingSettings, []);
          assert.deepEqual(rejected.report.mismatches, []);
        }
      }
      // Arrange
      const missing = structuredClone(workflow);
      missing.env.CI_STANDARD_BUNDLE_ID = '';
      fs.writeFileSync(path.join(root, workflowPath), yaml.stringify(missing));
      const missingContext = { ...context, report: createReport() };
      // Act
      validateQualityPreset(missingContext, preset);
      // Assert
      assert.ok(missingContext.report.missingSettings.some((item) => item.path === `${workflowPath}:env.CI_ADAPTER_DESCRIPTOR`));
      // Arrange
      const beforeMissing = snapshotTree(root);
      // Act
      const missingReport = validateCiPreset({ repoRoot: root, presets: ['quality-gate'] });
      // Assert
      assert.equal(missingReport.status, 'failed');
      assert.ok(missingReport.missingSettings.some((item) => item.path === `${workflowPath}:env.CI_ADAPTER_DESCRIPTOR`));
      assert.deepEqual(snapshotTree(root), beforeMissing);

      // Arrange
      const directoryDescriptor = structuredClone(missing);
      directoryDescriptor.env.CI_ADAPTER_DESCRIPTOR = '.ci/adapters/directory';
      fs.mkdirSync(path.join(root, directoryDescriptor.env.CI_ADAPTER_DESCRIPTOR), { recursive: true });
      fs.writeFileSync(path.join(root, workflowPath), yaml.stringify(directoryDescriptor));
      const directoryContext = { ...context, report: createReport() };
      // Act
      validateQualityPreset(directoryContext, preset);
      // Assert
      assert.ok(directoryContext.report.mismatches.some((item) => item.message === 'quality adapter descriptor must be a regular file'));
      // Arrange
      const beforeDirectory = snapshotTree(root);
      // Act
      const directoryReport = validateCiPreset({ repoRoot: root, presets: ['quality-gate'] });
      // Assert
      assert.equal(directoryReport.status, 'failed');
      assert.ok(directoryReport.mismatches.some((item) => item.message === 'quality adapter descriptor must be a regular file'));
      assert.deepEqual(snapshotTree(root), beforeDirectory);
      fs.rmSync(path.join(root, '.ci'), { recursive: true });
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
