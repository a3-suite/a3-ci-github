import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { loadRegistry } from '../preset-registry.ts';
import { managedAssets, resolveQualityWorkflow } from '../ci-preset-assets.ts';
import { inspectWorkflowAsset, validateProviderActionPinCompanion, validateCommon } from '../workflow-validation.ts';
import { validateQualityPreset, validateActionCoverage, validateQualityPlatformSelection } from '../quality-validation.ts';
import { createReport } from '../validation-report.ts';
import { standardQualityBundle } from '../../adapter/standard-quality-bundles.ts';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const yaml = createRequire(path.join(repository, 'runtime/preset/package.json'))('yaml');

// integration_id: quality-reusable-preflight
// contract_id: contract.ci-quality-workflow.execution
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
    assert.ok(observed.has('ci-quality-toolchain'));
    assert.ok(report.missingSettings.some((entry) => entry.path.endsWith('actions.ci-quality-toolchain')));
    assert.ok(observed.has('ci-change-scope'));
    assert.ok(observed.has('ci-quality-summary'));
    assert.ok(report.mismatches.every((entry) => entry.message === 'external Action must use a full commit SHA'), JSON.stringify(report));
    assert.deepEqual(managedAssets(root, registry, [preset]).map((entry) => entry.path), [asset.destination]);
    assert.equal(fs.existsSync(path.join(root, registry.qualityReusableWorkflow.source)), false);
    assert.equal(fs.existsSync(path.join(root, '.ci/adapters')), false);
    assert.equal(resolveQualityWorkflow(original, registry).env.CI_TOOLCHAIN_VERSION, '24.0.0');
    const withoutJq = structuredClone(original);
    withoutJq.jobs.quality.with['jq-version'] = '';
    const optionalJq = inspect(withoutJq).report;
    assert.ok(optionalJq.mismatches.every((entry) => entry.message === 'external Action must use a full commit SHA'), JSON.stringify(optionalJq));
    assert.equal(resolveQualityWorkflow(withoutJq, registry).env.CI_JQ_VERSION, '');
    delete withoutJq.jobs.quality.with['jq-version'];
    assert.equal(resolveQualityWorkflow(withoutJq, registry).env.CI_JQ_VERSION, '');
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
      [(value) => { delete value.jobs.quality.with['jq-version']; }, /canonical drift/],
      [(value) => { value.jobs.quality.with['jq-version'] = 'latest'; }, /empty or an exact version/],
      [(value) => { value.jobs.quality.with['jq-version'] = '${{ vars.JQ_VERSION }}'; }, /empty or an exact version/],
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

// integration_id: quality-platform-reusable-preflight
// contract_id: contract.ci-quality-workflow.execution
test('platform reusable preflight validates callee inputs quality selection and availability without consumer copies', () => {
  fs.mkdirSync(path.join(repository, 'tmp'), { recursive: true });
  const root = fs.mkdtempSync(path.join(repository, 'tmp/reusable-platform-preflight-'));
  try {
    const registryReport = createReport();
    const registry = loadRegistry(registryReport);
    assert.deepEqual(registryReport.mismatches, []);
    const preset = registry.presets.find((entry) => entry.id === 'quality-gate');
    const asset = preset.optionalWorkflowAssets[0];
    const original = yaml.parse(fs.readFileSync(path.join(repository, asset.source), 'utf8'));
    original.on.push.branches = ['main'];
    original.jobs['platform-summary']['runs-on'] = 'ubuntu-24.04';
    Object.assign(original.jobs.platforms.with, {
      runner: 'ubuntu-24.04', 'language-profile': 'typescript', 'toolchain-version': '24.0.0',
      'uv-version': '', 'cargo-audit-version': '', 'cargo-manifest-path': '', 'cargo-lock-path': '',
      'standard-bundle-id': 'typescript-npm-quality', 'adapter-descriptor': '',
    });
    fs.mkdirSync(path.join(root, '.ci'), { recursive: true });
    fs.mkdirSync(path.dirname(path.join(root, asset.destination)), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: Object.fromEntries(['format:check', 'lint', 'typecheck', 'test'].map((name) => [name, 'node --version'])) }));
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
    for (const file of ['Cargo.toml', 'Cargo.lock', 'pyproject.toml', 'uv.lock']) fs.writeFileSync(path.join(root, file), '\n');
    fs.writeFileSync(path.join(root, registry.platformManifestPath), 'platforms: [{id: linux-x64, runner: ubuntu-24.04, target: x86_64-unknown-linux-gnu}]\n');
    fs.writeFileSync(path.join(root, registry.qualityPlatformSelectionPath), 'platforms: [{id: linux-x64}]\n');
    const inspect = (workflow) => {
      const report = createReport();
      fs.writeFileSync(path.join(root, asset.destination), yaml.stringify(workflow));
      const observed = new Set();
      const context = { root, registry, report, parsed: new Map(), actionByPath: new Map(registry.actionTargets.map((target) => [`${registry.actionRepository}/${target.actionPath}`, target])) };
      inspectWorkflowAsset(context, preset, asset, observed);
      validateQualityPreset(context, preset);
      validateQualityPlatformSelection(context, preset);
      validateActionCoverage(context, preset, [asset], observed);
      return { report, observed };
    };
    const { report, observed } = inspect(original);
    assert.ok(report.missingSettings.some((entry) => entry.message.includes('platform reusable workflow is pending-release')));
    assert.ok(report.missingSettings.some((entry) => entry.path === 'quality-gate:actions.ci-platform-matrix'));
    for (const id of ['ci-platform-matrix', 'ci-quality-adapter', 'ci-quality-toolchain', 'ci-change-scope', 'ci-quality-summary']) assert.ok(observed.has(id), id);
    assert.ok(report.mismatches.every((entry) => entry.message === 'external Action must use a full commit SHA'), JSON.stringify(report));
    assert.deepEqual(managedAssets(root, registry, [preset]).map((entry) => entry.path), [asset.destination]);
    assert.equal(fs.existsSync(path.join(root, registry.qualityPlatformsReusableWorkflow.source)), false);
    assert.equal(fs.existsSync(path.join(root, '.ci/adapters')), false);
    const pins = createReport();
    validateProviderActionPinCompanion(root, new Map([[asset.destination, original]]), registry, pins);
    assert.deepEqual(pins.missingSettings, []);
    assert.deepEqual(pins.mismatches, []);
    for (const [profile, id, version] of [['rust', 'rust-cargo-quality', '1.90.0'], ['python', 'python-uv-quality', '3.13.1']]) {
      const workflow = structuredClone(original);
      Object.assign(workflow.jobs.platforms.with, { 'language-profile': profile, 'standard-bundle-id': id, 'toolchain-version': version,
        'uv-version': '0.8.0', 'cargo-audit-version': '0.21.0', 'cargo-manifest-path': 'Cargo.toml', 'cargo-lock-path': 'Cargo.lock' });
      assert.ok(inspect(workflow).report.mismatches.every((entry) => entry.message === 'external Action must use a full commit SHA'));
    }
    const legacy = structuredClone(original);
    legacy.jobs.platforms.with['standard-bundle-id'] = '';
    legacy.jobs.platforms.with['adapter-descriptor'] = '.ci/adapters/typescript-quality.yml';
    fs.mkdirSync(path.join(root, '.ci/adapters'), { recursive: true });
    fs.writeFileSync(path.join(root, legacy.jobs.platforms.with['adapter-descriptor']), standardQualityBundle('typescript-npm-quality').descriptor);
    assert.ok(inspect(legacy).report.mismatches.every((entry) => entry.message === 'external Action must use a full commit SHA'));
    for (const [mutate, diagnostic] of [
      [(value) => { value.jobs.platforms.uses = value.jobs.platforms.uses.replace(/@.*/, '@' + 'a'.repeat(40)); }, /ref does not match/],
      [(value) => { value.jobs.platforms.with.runner = 'ubuntu-latest'; }, /static versioned label/],
      [(value) => { value.jobs.platforms.with['toolchain-version'] = 24; }, /wrong type/],
      [(value) => { value.jobs.platforms.with['standard-bundle-id'] = 'unknown'; }, /not registered/],
      [(value) => { value.jobs.platforms.with['adapter-descriptor'] = '.ci/adapters/custom.yml'; }, /select exactly one/],
      [(value) => { value.jobs.platforms.with.unexpected = 'value'; }, /undeclared/],
      [(value) => { delete value.jobs.platforms.with['platform-manifest']; }, /required platform reusable workflow input is missing/],
      [(value) => { value.jobs.platforms.with['platform-manifest'] = '.ci/other.yml'; }, /canonical drift/],
      [(value) => { value.jobs.platforms.permissions.contents = 'write'; }, /canonical drift/],
      [(value) => { value.jobs.platforms.secrets = 'inherit'; }, /canonical drift/],
      [(value) => { value.jobs['platform-summary'].if = 'success()'; }, /canonical drift/],
    ]) {
      const workflow = structuredClone(original); mutate(workflow);
      assert.match(JSON.stringify(inspect(workflow).report), diagnostic);
    }
    fs.writeFileSync(path.join(root, registry.qualityPlatformSelectionPath), 'platforms: [{id: unknown}]\n');
    assert.match(JSON.stringify(inspect(original).report.mismatches), /not declared in the platform manifest/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// integration_id: package-preparation-reusable-preflight
// contract_id: contract.ci-package-publication-workflow.publication
test('package preparation fixed source preflight rejects drift and retains owner adapters without callee copies', () => {
  fs.mkdirSync(path.join(repository, 'tmp'), { recursive: true });
  const root = fs.mkdtempSync(path.join(repository, 'tmp/reusable-package-preflight-'));
  try {
    const registryReport = createReport();
    const registry = loadRegistry(registryReport);
    assert.deepEqual(registryReport.mismatches, []);
    const preset = registry.presets.find((entry) => entry.id === 'package-publication');
    assert.equal(preset.workflowAssets.length, 2);
    assert.deepEqual(preset.assets.requiredExtensions, ['package-build-adapter', 'package-publication-adapter']);
    const asset = preset.workflowAssets.find((entry) => entry.id === 'package-publication-caller');
    const original = yaml.parse(fs.readFileSync(path.join(repository, asset.source), 'utf8'));
    fs.mkdirSync(path.dirname(path.join(root, asset.destination)), { recursive: true });
    fs.mkdirSync(path.join(root, '.ci/scripts'), { recursive: true });
    fs.writeFileSync(path.join(root, '.ci/scripts/ci-package-build.sh'), '#!/bin/bash\n');
    const inspect = (workflow, selectedRegistry = registry) => {
      fs.writeFileSync(path.join(root, asset.destination), yaml.stringify(workflow));
      const report = createReport(); const observed = new Set();
      const context = { root, registry: selectedRegistry, report, parsed: new Map(), actionByPath: new Map(registry.actionTargets.map((target) => [`${registry.actionRepository}/${target.actionPath}`, target])) };
      inspectWorkflowAsset(context, preset, asset, observed);
      return { report, observed };
    };
    const { report, observed } = inspect(original);
    assert.ok(report.missingSettings.some((entry) => entry.message.includes('package preparation reusable workflow is pending-release')));
    assert.ok(observed.has('ci-publish-version'));
    assert.ok(!report.mismatches.some((entry) => entry.message.includes('package preparation')));
    assert.deepEqual(managedAssets(root, registry, [preset]).map((entry) => entry.path), [asset.destination]);
    assert.equal(fs.existsSync(path.join(root, registry.packagePreparationReusableWorkflow.source)), false);
    assert.equal(fs.existsSync(path.join(root, '.github/workflows/package-preparation.yml')), false);
    for (const [mutate, diagnostic] of [
      [(value) => { value.jobs.prepare.uses = value.jobs.prepare.uses.replace(/@.*/, '@' + 'a'.repeat(40)); }, /ref does not match/],
      [(value) => { delete value.jobs.prepare.with.source_sha; }, /required package preparation input is missing/],
      [(value) => { value.jobs.prepare.with.version = 1; }, /wrong type/],
      [(value) => { value.jobs.prepare.with.unexpected = 'value'; }, /undeclared/],
      [(value) => { value.jobs.prepare.permissions.contents = 'write'; }, /canonical drift/],
      [(value) => { value.jobs.prepare.secrets = 'inherit'; }, /canonical drift/],
    ]) {
      const workflow = structuredClone(original); mutate(workflow);
      const result = inspect(workflow).report;
      assert.match(JSON.stringify([...result.missingSettings, ...result.mismatches]), diagnostic);
    }
    const available = { ...registry, packagePreparationReusableWorkflow: { ...registry.packagePreparationReusableWorkflow, status: 'available', exactRef: 'a'.repeat(40) } };
    const released = structuredClone(original); released.jobs.prepare.uses = released.jobs.prepare.uses.replace(/@.*/, '@' + 'a'.repeat(40));
    assert.ok(!inspect(released, available).report.missingSettings.some((entry) => entry.message.includes('package preparation reusable workflow is pending-release')));
    const missing = { ...registry, packagePreparationReusableWorkflow: { ...registry.packagePreparationReusableWorkflow, source: '.github/workflows/missing-package.yml' } };
    assert.match(JSON.stringify(inspect(original, missing).report.mismatches), /source is missing/);
    fs.unlinkSync(path.join(root, '.ci/scripts/ci-package-build.sh'));
    assert.ok(inspect(original).report.missingSettings.some((entry) => entry.path === '.ci/scripts/ci-package-build.sh'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// integration_id: preset-assurance-contract
// contract_id: contract.ci-preset-assurance.verification
test('quality toolchain preflight rejects missing extra and altered input bindings', () => {
  const registry = loadRegistry(createReport());
  const inputs = { 'language-profile': '${{ env.CI_LANGUAGE_PROFILE }}', 'toolchain-version': '${{ env.CI_TOOLCHAIN_VERSION }}', 'uv-version': '${{ env.CI_UV_VERSION }}', 'cargo-audit-version': '${{ env.CI_CARGO_AUDIT_VERSION }}' };
  for (const change of [null, (value) => delete value['uv-version'], (value) => { value.extra = 'unexpected'; }, (value) => { value['toolchain-version'] = '24.0.0'; }, (value) => { value['language-profile'] = 1; }]) {
    const withInputs = { ...inputs };
    change?.(withInputs);
    const workflow = { jobs: { quality: { steps: [{ uses: `${registry.actionRepository}/actions/ci-quality-toolchain@${'a'.repeat(40)}`, with: withInputs }] } } };
    const report = createReport();
    validateCommon(repository, 'workflow.yml', JSON.stringify(workflow), workflow, report, registry);
    assert.equal(report.mismatches.some((item) => item.path === 'workflow.yml:with.ci-quality-toolchain'), change !== null);
  }
});
