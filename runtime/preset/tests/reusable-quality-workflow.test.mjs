import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test, describe, expect } from 'vitest';
import { loadRegistry } from '../preset-registry.ts';
import { managedAssets, qualityProfileCallers, resolveQualityWorkflow } from '../ci-preset-assets.ts';
import { inspectWorkflowAsset, validateProviderActionPinCompanion, validateCommon } from '../workflow-validation.ts';
import { validateQualityPreset, validateActionCoverage, validateQualityPlatformSelection } from '../quality-validation.ts';
import { createReport } from '../validation-report.ts';
import { standardQualityBundle } from '../../adapter/standard-quality-bundles.ts';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const yaml = createRequire(path.join(repository, 'runtime/preset/package.json'))('yaml');

describe("contract.ci-quality-workflow.execution", () => {
  describe("quality-reusable-preflight", () => {
    // integration_id: quality-reusable-preflight
    // contract_id: contract.ci-quality-workflow.execution
    test('reusable quality preflight connects fixed source without copying the callee and rejects caller drift', () => {
      fs.mkdirSync(path.join(repository, 'tmp'), { recursive: true });
      const root = fs.mkdtempSync(path.join(repository, 'tmp/reusable-quality-preflight-'));
      const registryReport = createReport();
      const registry = loadRegistry(registryReport);
      expect(registryReport.mismatches).toStrictEqual([]);
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
        expect(pinReport.missingSettings).toStrictEqual([]);
        expect(pinReport.mismatches).toStrictEqual([]);
        expect(fs.existsSync(path.join(root, '.ci/provider-action-pins.yml'))).toBe(false);
        expect(report.missingSettings.some((entry) => entry.message.includes('quality reusable workflow is pending-release'))).toBeTruthy();
        expect(observed.has('ci-quality-adapter')).toBeTruthy();
        expect(observed.has('ci-quality-toolchain')).toBeTruthy();
        expect(report.missingSettings.some((entry) => entry.path.endsWith('actions.ci-quality-toolchain'))).toBe(false);
        expect(observed.has('ci-change-scope')).toBeTruthy();
        expect(observed.has('ci-quality-summary')).toBeTruthy();
        expect(report.mismatches.every((entry) => entry.message === 'external Action must use a full commit SHA'), JSON.stringify(report)).toBeTruthy();
        expect(managedAssets(root, registry, [preset]).map((entry) => entry.path)).toStrictEqual([asset.destination]);
        expect(fs.existsSync(path.join(root, registry.qualityReusableWorkflow.source))).toBe(false);
        expect(fs.existsSync(path.join(root, '.ci/adapters'))).toBe(false);
        expect(resolveQualityWorkflow(original, registry).env.CI_TOOLCHAIN_VERSION).toBe('24.0.0');
        const withoutJq = structuredClone(original);
        withoutJq.jobs.quality.with['jq-version'] = '';
        const optionalJq = inspect(withoutJq).report;
        expect(optionalJq.mismatches.every((entry) => entry.message === 'external Action must use a full commit SHA'), JSON.stringify(optionalJq)).toBeTruthy();
        expect(resolveQualityWorkflow(withoutJq, registry).env.CI_JQ_VERSION).toBe('');
        delete withoutJq.jobs.quality.with['jq-version'];
        expect(resolveQualityWorkflow(withoutJq, registry).env.CI_JQ_VERSION).toBe('');
        for (const [profile, id, version] of [['rust', 'rust-cargo-quality', '1.90.0'], ['python', 'python-uv-quality', '3.13.1']]) {
          const workflow = structuredClone(original);
          Object.assign(workflow.jobs.quality.with, { 'language-profile': profile, 'standard-bundle-id': id, 'toolchain-version': version,
            'uv-version': '0.8.0', 'cargo-audit-version': '0.21.0', 'cargo-manifest-path': 'Cargo.toml', 'cargo-lock-path': 'Cargo.lock' });
          const result = inspect(workflow).report;
          expect(result.mismatches.every((entry) => entry.message === 'external Action must use a full commit SHA'), JSON.stringify(result)).toBeTruthy();
          expect(managedAssets(root, registry, [preset]).map((entry) => entry.path)).toStrictEqual([asset.destination]);
        }
        const legacy = structuredClone(original);
        legacy.jobs.quality.with['standard-bundle-id'] = '';
        legacy.jobs.quality.with['adapter-descriptor'] = '.ci/adapters/typescript-quality.yml';
        fs.mkdirSync(path.join(root, '.ci/adapters'), { recursive: true });
        fs.writeFileSync(path.join(root, legacy.jobs.quality.with['adapter-descriptor']), standardQualityBundle('typescript-npm-quality').descriptor);
        const legacyResult = inspect(legacy).report;
        expect(legacyResult.mismatches.some((entry) => entry.message === 'standard quality bundle must use the Action bundle ID')).toBeTruthy();
        expect(managedAssets(root, registry, [preset]).map((entry) => entry.path)).toStrictEqual([asset.destination]);
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
          expect(JSON.stringify([...result.mismatches, ...result.missingSettings])).toMatch(diagnostic);
        }
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
  });
});

describe("contract.ci-quality-workflow.execution", () => {
  describe("quality-profiles-reusable-preflight", () => {
    // integration_id: quality-profiles-reusable-preflight
    // contract_id: contract.ci-quality-workflow.execution
    test('profiles preflight validates every language profile as its own quality caller and rejects malformed profiles', () => {
      fs.mkdirSync(path.join(repository, 'tmp'), { recursive: true });
      const root = fs.mkdtempSync(path.join(repository, 'tmp/profiles-quality-preflight-'));
      const registry = loadRegistry(createReport());
      const preset = registry.presets.find((entry) => entry.id === 'quality-gate-profiles');
      const asset = preset.workflowAssets[0];
      const original = yaml.parse(fs.readFileSync(path.join(repository, asset.source), 'utf8'));
      original.on.push.branches = ['main'];
      original.jobs['profiles-summary']['runs-on'] = 'ubuntu-24.04';
      original.jobs.quality.with.runner = 'ubuntu-24.04';
      const unused = Object.fromEntries(Object.keys(original.jobs.quality.with)
        .filter((name) => !['runner', 'docs-only-patterns'].includes(name)).map((name) => [name, '']));
      original.jobs.quality.strategy.matrix.include = [
        { ...unused, 'language-profile': 'rust', 'toolchain-version': '1.90.0', 'cargo-audit-version': '0.21.0',
          'cargo-manifest-path': 'Cargo.toml', 'cargo-lock-path': 'Cargo.lock', 'standard-bundle-id': 'rust-cargo-quality' },
        { ...unused, 'language-profile': 'python', 'toolchain-version': '3.13.1', 'uv-version': '0.8.0', 'standard-bundle-id': 'python-uv-quality' },
      ];
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
      const findings = (report) => JSON.stringify([...report.mismatches, ...report.missingSettings]);
      try {
        fs.mkdirSync(path.dirname(path.join(root, asset.destination)), { recursive: true });
        for (const file of ['Cargo.toml', 'Cargo.lock', 'pyproject.toml', 'uv.lock']) fs.writeFileSync(path.join(root, file), '\n');
        // Act
        const { report, observed } = inspect(original);
        // Assert
        expect(report.mismatches.every((entry) => entry.message === 'external Action must use a full commit SHA'), findings(report)).toBeTruthy();
        // The fixture keeps the unreleased callee reference, which preflight reports as pending rather than as a profile problem.
        expect(report.missingSettings.every((entry) => /pending-release|unresolved placeholders/.test(entry.message)), findings(report)).toBeTruthy();
        for (const action of ['ci-quality-adapter', 'ci-quality-toolchain', 'ci-change-scope', 'ci-quality-summary']) expect(observed.has(action), action).toBeTruthy();
        expect(managedAssets(root, registry, [preset]).map((entry) => entry.path)).toStrictEqual([asset.destination]);
        expect(fs.existsSync(path.join(root, registry.qualityReusableWorkflow.source))).toBe(false);
        expect(qualityProfileCallers(original).map((caller) => resolveQualityWorkflow(caller, registry).env.CI_LANGUAGE_PROFILE)).toStrictEqual(['rust', 'python']);
        expect(resolveQualityWorkflow(qualityProfileCallers(original)[1], registry).env.CI_CARGO_AUDIT_VERSION).toBe('');
        // The auxiliary language commonly carries its own descriptor beside the primary standard bundle.
        const descriptorPath = '.ci/adapters/python-quality.yml';
        const descriptor = { schemaVersion: '1', kind: 'ci-adapter-bundle', id: 'python-lint', contract: 'quality-scripts',
          languageProfiles: ['python'], provider: 'provider-neutral', executionBoundary: 'read-only', sourceCheckout: 'fixed-source',
          copyable: true, owner: 'project', projectSettings: { requiredFiles: ['pyproject.toml'], requiredScripts: [], requiredEnvironmentPaths: [] },
          toolchain: { versionEnv: 'CI_TOOLCHAIN_VERSION', verify: { id: 'version', command: 'python', args: ['--version'] } },
          preparation: [{ id: 'sync', command: 'uv', args: ['sync', '--locked'] }], commands: [{ id: 'lint', command: 'uv', args: ['run', 'ruff', 'check'] }] };
        fs.mkdirSync(path.join(root, '.ci/adapters'), { recursive: true });
        fs.writeFileSync(path.join(root, descriptorPath), yaml.stringify(descriptor));
        const mixed = structuredClone(original);
        Object.assign(mixed.jobs.quality.strategy.matrix.include[1], { 'standard-bundle-id': '', 'adapter-descriptor': descriptorPath });
        const mixedReport = inspect(mixed).report;
        expect(mixedReport.mismatches.every((entry) => entry.message === 'external Action must use a full commit SHA'), findings(mixedReport)).toBeTruthy();
        expect(mixedReport.missingSettings.every((entry) => /pending-release|unresolved placeholders/.test(entry.message)), findings(mixedReport)).toBeTruthy();
        fs.writeFileSync(path.join(root, descriptorPath), yaml.stringify({ ...descriptor, languageProfiles: ['rust'] }));
        expect(findings(inspect(mixed).report)).toMatch(/does not support the selected language profile/);
        fs.rmSync(path.join(root, descriptorPath));
        expect(findings(inspect(mixed).report)).toMatch(/python-quality\.yml/);
        const profiles = (value) => value.jobs.quality.strategy.matrix.include;
        for (const [mutate, diagnostic] of [
          [(value) => { profiles(value)[1]['uv-version'] = ''; }, /CI_UV_VERSION is required/],
          [(value) => { delete profiles(value)[1]['jq-version']; }, /include\[1\]\.jq-version.*must state every per-profile input/],
          [(value) => { profiles(value)[0]['toolchain-version'] = ''; }, /include\[0\]\.toolchain-version.*required quality workflow input is empty/],
          [(value) => { profiles(value)[0].constructor = 'ignored'; }, /include\[0\]\.constructor.*not a per-profile/],
          [(value) => { profiles(value)[1]['standard-bundle-id'] = 'rust-cargo-quality'; }, /not registered for this language profile/],
          [(value) => { profiles(value)[1]['adapter-descriptor'] = '.ci/adapters/python.yml'; }, /select exactly one/],
          [(value) => { delete profiles(value)[0]['toolchain-version']; }, /include\[0\]\.toolchain-version.*must state every per-profile input/],
          [(value) => { profiles(value)[0].runner = 'ubuntu-24.04'; }, /include\[0\]\.runner.*not a per-profile/],
          [(value) => { profiles(value)[0].unexpected = 'value'; }, /not a per-profile/],
          [(value) => { profiles(value)[0]['jq-version'] = 'latest'; }, /empty or an exact version/],
          [(value) => { profiles(value).push(structuredClone(profiles(value)[1])); }, /listed more than once/],
          [(value) => { value.jobs.quality.strategy.matrix.include = []; }, /matrix include must list/],
          [(value) => { profiles(value)[0]['uv-version'] = 1; }, /matrix include must list/],
          [(value) => { value.jobs.quality.with['language-profile'] = 'rust'; }, /canonical drift/],
          [(value) => { value.jobs.quality.strategy['fail-fast'] = true; }, /canonical drift/],
          [(value) => { value.jobs['profiles-summary'].name = 'summary'; }, /canonical drift/],
        ]) {
          const workflow = structuredClone(original); mutate(workflow);
          expect(findings(inspect(workflow).report)).toMatch(diagnostic);
        }
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
  });
});

describe("contract.ci-quality-workflow.execution", () => {
  describe("quality-platform-reusable-preflight", () => {
    // integration_id: quality-platform-reusable-preflight
    // contract_id: contract.ci-quality-workflow.execution
    test('platform reusable preflight validates callee inputs quality selection and availability without consumer copies', () => {
      fs.mkdirSync(path.join(repository, 'tmp'), { recursive: true });
      const root = fs.mkdtempSync(path.join(repository, 'tmp/reusable-platform-preflight-'));
      try {
        const registryReport = createReport();
        const registry = loadRegistry(registryReport);
        expect(registryReport.mismatches).toStrictEqual([]);
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
        expect(report.missingSettings.some((entry) => entry.message.includes('platform reusable workflow is pending-release'))).toBeTruthy();
        expect(report.missingSettings.some((entry) => entry.path === 'quality-gate:actions.ci-platform-matrix')).toBe(false);
        for (const id of ['ci-platform-matrix', 'ci-quality-adapter', 'ci-quality-toolchain', 'ci-change-scope', 'ci-quality-summary']) expect(observed.has(id), id).toBeTruthy();
        expect(report.mismatches.every((entry) => entry.message === 'external Action must use a full commit SHA'), JSON.stringify(report)).toBeTruthy();
        expect(managedAssets(root, registry, [preset]).map((entry) => entry.path)).toStrictEqual([asset.destination]);
        expect(fs.existsSync(path.join(root, registry.qualityPlatformsReusableWorkflow.source))).toBe(false);
        expect(fs.existsSync(path.join(root, '.ci/adapters'))).toBe(false);
        const pins = createReport();
        validateProviderActionPinCompanion(root, new Map([[asset.destination, original]]), registry, pins);
        expect(pins.missingSettings).toStrictEqual([]);
        expect(pins.mismatches).toStrictEqual([]);
        for (const [profile, id, version] of [['rust', 'rust-cargo-quality', '1.90.0'], ['python', 'python-uv-quality', '3.13.1']]) {
          const workflow = structuredClone(original);
          Object.assign(workflow.jobs.platforms.with, { 'language-profile': profile, 'standard-bundle-id': id, 'toolchain-version': version,
            'uv-version': '0.8.0', 'cargo-audit-version': '0.21.0', 'cargo-manifest-path': 'Cargo.toml', 'cargo-lock-path': 'Cargo.lock' });
          expect(inspect(workflow).report.mismatches.every((entry) => entry.message === 'external Action must use a full commit SHA')).toBeTruthy();
        }
        const legacy = structuredClone(original);
        legacy.jobs.platforms.with['standard-bundle-id'] = '';
        legacy.jobs.platforms.with['adapter-descriptor'] = '.ci/adapters/typescript-quality.yml';
        fs.mkdirSync(path.join(root, '.ci/adapters'), { recursive: true });
        fs.writeFileSync(path.join(root, legacy.jobs.platforms.with['adapter-descriptor']), standardQualityBundle('typescript-npm-quality').descriptor);
        expect(inspect(legacy).report.mismatches.some((entry) => entry.message === 'standard quality bundle must use the Action bundle ID')).toBeTruthy();
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
          expect(JSON.stringify(inspect(workflow).report)).toMatch(diagnostic);
        }
        fs.writeFileSync(path.join(root, registry.qualityPlatformSelectionPath), 'platforms: [{id: unknown}]\n');
        expect(JSON.stringify(inspect(original).report.mismatches)).toMatch(/not declared in the platform manifest/);
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
  });
});

describe("contract.ci-package-publication-workflow.publication", () => {
  describe("package-preparation-reusable-preflight", () => {
    // integration_id: package-preparation-reusable-preflight
    // contract_id: contract.ci-package-publication-workflow.publication
    test('package preparation fixed source preflight rejects drift and retains owner adapters without callee copies', () => {
      fs.mkdirSync(path.join(repository, 'tmp'), { recursive: true });
      const root = fs.mkdtempSync(path.join(repository, 'tmp/reusable-package-preflight-'));
      try {
        const registryReport = createReport();
        const registry = loadRegistry(registryReport);
        expect(registryReport.mismatches).toStrictEqual([]);
        const preset = registry.presets.find((entry) => entry.id === 'package-publication');
        expect(preset.workflowAssets.length).toBe(2);
        expect(preset.assets.requiredExtensions).toStrictEqual(['package-build-adapter', 'package-publication-adapter']);
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
        expect(report.missingSettings.some((entry) => entry.message.includes('package preparation reusable workflow is pending-release'))).toBeTruthy();
        expect(observed.has('ci-publish-version')).toBeTruthy();
        expect(!report.mismatches.some((entry) => entry.message.includes('package preparation'))).toBeTruthy();
        expect(managedAssets(root, registry, [preset]).map((entry) => entry.path)).toStrictEqual([registry.providerActionPinCompanionPath, asset.destination]);
        expect(fs.existsSync(path.join(root, registry.packagePreparationReusableWorkflow.source))).toBe(false);
        expect(fs.existsSync(path.join(root, '.github/workflows/package-preparation.yml'))).toBe(false);
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
          expect(JSON.stringify([...result.missingSettings, ...result.mismatches])).toMatch(diagnostic);
        }
        const available = { ...registry, packagePreparationReusableWorkflow: { ...registry.packagePreparationReusableWorkflow, status: 'available', exactRef: 'a'.repeat(40) } };
        const released = structuredClone(original); released.jobs.prepare.uses = released.jobs.prepare.uses.replace(/@.*/, '@' + 'a'.repeat(40));
        expect(!inspect(released, available).report.missingSettings.some((entry) => entry.message.includes('package preparation reusable workflow is pending-release'))).toBeTruthy();
        const missing = { ...registry, packagePreparationReusableWorkflow: { ...registry.packagePreparationReusableWorkflow, source: '.github/workflows/missing-package.yml' } };
        expect(JSON.stringify(inspect(original, missing).report.mismatches)).toMatch(/source is missing/);
        fs.unlinkSync(path.join(root, '.ci/scripts/ci-package-build.sh'));
        expect(inspect(original).report.missingSettings.some((entry) => entry.path === '.ci/scripts/ci-package-build.sh')).toBeTruthy();
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
  });
});

describe("contract.ci-preset-assurance.verification", () => {
  describe("preset-assurance-contract", () => {
    // integration_id: preset-assurance-contract
    // contract_id: contract.ci-preset-assurance.verification
    test('quality toolchain preflight rejects missing extra and altered input bindings', () => {
      const registry = loadRegistry(createReport());
      const inputs = { 'language-profile': '${{ env.CI_LANGUAGE_PROFILE }}', 'toolchain-version': '${{ env.CI_TOOLCHAIN_VERSION }}', 'uv-version': '${{ env.CI_UV_VERSION }}', 'cargo-audit-version': '${{ env.CI_CARGO_AUDIT_VERSION }}', 'cargo-deny-version': '${{ env.CI_CARGO_DENY_VERSION }}' };
      const scopeSelection = "${{ steps.execution-scope.outputs.scope == 'native' && 'skip' || 'install' }}";
      for (const [change, rejected] of [[null, false], [(value) => { value['auxiliary-tools'] = 'skip'; }, false], [(value) => { value['auxiliary-tools'] = scopeSelection; }, false],
        [(value) => { value['auxiliary-tools'] = 'install'; }, true], [(value) => { value['auxiliary-tools'] = 'none'; }, true],
        [(value) => delete value['uv-version'], true], [(value) => { value.extra = 'unexpected'; }, true], [(value) => { value['toolchain-version'] = '24.0.0'; }, true], [(value) => { value['language-profile'] = 1; }, true]]) {
        const withInputs = { ...inputs };
        change?.(withInputs);
        const workflow = { jobs: { quality: { steps: [{ uses: `${registry.actionRepository}/actions/ci-quality-toolchain@${'a'.repeat(40)}`, with: withInputs }] } } };
        const report = createReport();
        validateCommon(repository, 'workflow.yml', JSON.stringify(workflow), workflow, report, registry);
        expect(report.mismatches.some((item) => item.path === 'workflow.yml:with.ci-quality-toolchain'), JSON.stringify(withInputs)).toBe(rejected);
      }
    });
  });
});
