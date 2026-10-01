import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadRegistry, managedAssets } from '../ci-preset-assets.ts';
import { validateQualityPreset } from '../quality-validation.ts';
import { createReport } from '../validation-report.ts';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const yaml = createRequire(path.join(repository, 'runtime/preset/package.json'))('yaml');

// integration_id: preset-assurance-contract
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
        (value) => { value.env.CI_ADAPTER_DESCRIPTOR = '.ci/adapters/override.yml'; },
        (value) => { value.jobs.quality.steps[0].with['standard-bundle-id'] = '${{ github.event.pull_request.head.sha }}'; },
      ]) {
        const changed = structuredClone(workflow); mutation(changed);
        fs.writeFileSync(path.join(root, workflowPath), yaml.stringify(changed));
        const rejected = { ...context, report: createReport() };
        validateQualityPreset(rejected, preset);
        assert.ok(rejected.report.mismatches.length > 0);
      }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
