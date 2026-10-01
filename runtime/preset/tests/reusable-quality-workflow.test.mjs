import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadRegistry, managedAssets, resolveQualityWorkflow } from '../ci-preset-assets.ts';
import { inspectWorkflowAsset, validateProviderActionPinCompanion } from '../workflow-validation.ts';
import { validateQualityPreset, validateActionCoverage } from '../quality-validation.ts';
import { createReport } from '../validation-report.ts';
import { standardQualityBundle } from '../../adapter/standard-quality-bundles.ts';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const yaml = createRequire(path.join(repository, 'runtime/preset/package.json'))('yaml');

// integration_id: preset-assurance-contract
test('reusable quality preflight connects fixed source without copying the callee and rejects caller drift', () => {
  fs.mkdirSync(path.join(repository, 'tmp'), { recursive: true });
  const root = fs.mkdtempSync(path.join(repository, 'tmp/reusable-quality-preflight-'));
  const registryReport = createReport();
  const registry = loadRegistry(registryReport);
  assert.deepEqual(registryReport.mismatches, []);
  const preset = registry.presets.find((entry) => entry.id === 'quality-gate');
  const asset = preset.workflowAssets[0];
  const original = yaml.parse(fs.readFileSync(path.join(repository, asset.source), 'utf8'));
  original.on.push.branches = ['main'];
  original.jobs.summary['runs-on'] = 'ubuntu-24.04';
  Object.assign(original.jobs.quality.with, {
    runner: 'ubuntu-24.04', 'language-profile': 'typescript', 'toolchain-version': '24.0.0',
    'uv-version': '', 'cargo-audit-version': '', 'cargo-manifest-path': '', 'cargo-lock-path': '',
    'jq-version': '1.8.1', 'standard-bundle-id': 'typescript-npm-quality', 'adapter-descriptor': '',
  });
  const inspect = (workflow) => {
    const report = createReport();
    fs.writeFileSync(path.join(root, asset.destination), yaml.stringify(workflow));
    const observed = new Set();
    const context = { root, registry, report, parsed: new Map(), actionByPath: new Map(registry.actionTargets.map((target) => [`${registry.actionRepository}/${target.actionPath}`, target])) };
    inspectWorkflowAsset(context, preset, asset, observed);
    validateQualityPreset(context, preset);
    validateActionCoverage(context, preset, [asset], observed);
    return { report, observed };
  };
  try {
    fs.mkdirSync(path.dirname(path.join(root, asset.destination)), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: Object.fromEntries(['format:check', 'lint', 'typecheck', 'test'].map((name) => [name, 'node --version'])) }));
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
    for (const file of ['Cargo.toml', 'Cargo.lock', 'pyproject.toml', 'uv.lock']) fs.writeFileSync(path.join(root, file), '\n');
    const { report, observed } = inspect(original);
    const pinReport = createReport();
    validateProviderActionPinCompanion(root, new Map([[asset.destination, original]]), registry, pinReport);
    assert.deepEqual(pinReport.missingSettings, []);
    assert.deepEqual(pinReport.mismatches, []);
    assert.equal(fs.existsSync(path.join(root, '.ci/provider-action-pins.yml')), false);
    assert.ok(report.missingSettings.some((entry) => entry.message.includes('quality reusable workflow is pending-release')));
    assert.ok(observed.has('ci-quality-adapter'));
    assert.ok(observed.has('ci-change-scope'));
    assert.ok(observed.has('ci-quality-summary'));
    assert.ok(report.mismatches.every((entry) => entry.message === 'external Action must use a full commit SHA'), JSON.stringify(report));
    assert.deepEqual(managedAssets(root, registry, [preset]).map((entry) => entry.path), [asset.destination]);
    assert.equal(fs.existsSync(path.join(root, registry.qualityReusableWorkflow.source)), false);
    assert.equal(fs.existsSync(path.join(root, '.ci/adapters')), false);
    assert.equal(resolveQualityWorkflow(original, registry).env.CI_TOOLCHAIN_VERSION, '24.0.0');
    for (const [profile, id, version] of [['rust', 'rust-cargo-quality', '1.90.0'], ['python', 'python-uv-quality', '3.13.1']]) {
      const workflow = structuredClone(original);
      Object.assign(workflow.jobs.quality.with, { 'language-profile': profile, 'standard-bundle-id': id, 'toolchain-version': version,
        'uv-version': '0.8.0', 'cargo-audit-version': '0.21.0', 'cargo-manifest-path': 'Cargo.toml', 'cargo-lock-path': 'Cargo.lock' });
      const result = inspect(workflow).report;
      assert.ok(result.mismatches.every((entry) => entry.message === 'external Action must use a full commit SHA'), JSON.stringify(result));
      assert.deepEqual(managedAssets(root, registry, [preset]).map((entry) => entry.path), [asset.destination]);
    }
    const legacy = structuredClone(original);
    legacy.jobs.quality.with['standard-bundle-id'] = '';
    legacy.jobs.quality.with['adapter-descriptor'] = '.ci/adapters/typescript-quality.yml';
    fs.mkdirSync(path.join(root, '.ci/adapters'), { recursive: true });
    fs.writeFileSync(path.join(root, legacy.jobs.quality.with['adapter-descriptor']), standardQualityBundle('typescript-npm-quality').descriptor);
    const legacyResult = inspect(legacy).report;
    assert.ok(legacyResult.mismatches.every((entry) => entry.message === 'external Action must use a full commit SHA'), JSON.stringify(legacyResult));
    for (const [mutate, diagnostic] of [
      [(value) => { value.jobs.quality.uses = value.jobs.quality.uses.replace(/@.*/, '@' + 'a'.repeat(40)); }, /ref does not match/],
      [(value) => { value.jobs.quality.with.runner = 'ubuntu-latest'; }, /static versioned label/],
      [(value) => { value.jobs.quality.with.runner = '${{ github.event.pull_request.head.ref }}'; }, /static versioned label/],
      [(value) => { value.jobs.quality.with['toolchain-version'] = 24; }, /wrong type/],
      [(value) => { value.jobs.quality.with['standard-bundle-id'] = 'unknown'; }, /not registered/],
      [(value) => { value.jobs.quality.with['adapter-descriptor'] = '.ci/adapters/custom.yml'; }, /select exactly one/],
      [(value) => { value.jobs.quality.with.unexpected = 'value'; }, /undeclared/],
      [(value) => { delete value.jobs.quality.with['jq-version']; }, /required quality reusable workflow input is missing/],
      [(value) => { value.jobs.quality.permissions.contents = 'write'; }, /canonical drift/],
      [(value) => { value.jobs.quality.secrets = 'inherit'; }, /canonical drift/],
      [(value) => { value.jobs.summary.if = 'success()'; }, /canonical drift/],
    ]) {
      const workflow = structuredClone(original); mutate(workflow);
      const result = inspect(workflow).report;
      assert.match(JSON.stringify([...result.mismatches, ...result.missingSettings]), diagnostic);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
