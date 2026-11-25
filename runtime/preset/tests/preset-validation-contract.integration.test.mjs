import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import { stringify } from 'yaml';
import path from 'node:path';
import { test, describe, expect, vi } from 'vitest';
import { fileURLToPath } from 'node:url';

import { loadRegistry, parseYaml } from '../preset-registry.ts';
import { validateCiPresetInternal } from '../validate-ci-preset-core.ts';
import { validateDescriptor } from '../descriptor-validation.ts';
import { createReport } from '../validation-report.ts';
import { validateStandardImplementation, validateConditionalExtensions } from '../quality-validation.ts';
import { validateCommon } from '../workflow-validation.ts';
import { findWorkflowAssetReferences } from '../workflow-assets.ts';
import {
  loadReleaseRequestFixtureModel,
  snapshotTree,
  writeReleaseRequestFixture,
} from './support/release-request-fixture.mjs';
import { ownerDescriptor } from './support/owner-descriptor-fixture.mjs';

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testRoot, '../../..');
const runtimeRoot = process.env.CI_GITHUB_PREFLIGHT_RUNTIME_ROOT ?? path.resolve(testRoot, '..');
const model = loadReleaseRequestFixtureModel({ repositoryRoot, runtimeRoot });
expect(model.preset.assets?.copyable ?? []).toStrictEqual([]);
const withFixture = (callback) => {
  const root = mkdtempSync(path.join(repositoryRoot, 'tmp/a3-ci-github-preset-contract-'));
  try {
    writeReleaseRequestFixture({ repositoryRoot, root, model });
    callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
    expect(existsSync(root)).toBe(false);
  }
};


describe("preset-validation-contract", () => {
  describe("preset-assurance-contract", () => {
    // integration_id: preset-assurance-contract
    test('registry binds every canonical workflow Action use to a declared target', () => {
      // Arrange
      const report = { missingSettings: [], mismatches: [] };
      const registry = loadRegistry(report);
      const actionUse = /uses: (a3-suite\/[^@\s]+)@([^\s]+)/g;
      // Act
      const coverage = registry.presets.map((preset) => {
        const assets = [...preset.workflowAssets, ...(preset.optionalWorkflowAssets ?? [])];
        const installed = new Set(assets.map((asset) => asset.id));
        if (['release-publication', 'asset-release-publication', 'package-publication'].includes(preset.id)) installed.add(preset.id);
        if (installed.has('package-publication-caller')) installed.add('package-preparation');
        const declared = new Set(registry.actionTargets
          .filter((target) => target.workflows.some((workflow) => installed.has(workflow)))
          .map((target) => target.id));
        const observed = new Set();
        for (const asset of assets) {
          let workflow = readFileSync(path.join(repositoryRoot, asset.source), 'utf8');
          if (asset.id === 'release-publication-caller') workflow += readFileSync(path.join(repositoryRoot, registry.releasePublicationReusableWorkflow.source), 'utf8');
          if (asset.id === 'asset-release-publication-caller') workflow += readFileSync(path.join(repositoryRoot, registry.assetReleasePublicationReusableWorkflow.source), 'utf8');
          if (asset.id === 'package-publication-caller') workflow += readFileSync(path.join(repositoryRoot, registry.packagePublicationReusableWorkflow.source), 'utf8');
          if (['quality-gate', 'quality-gate-profiles'].includes(asset.id)) workflow += readFileSync(path.join(repositoryRoot, registry.qualityReusableWorkflow.source), 'utf8');
          if (asset.id === 'package-publication-caller') workflow += readFileSync(path.join(repositoryRoot, registry.packagePreparationReusableWorkflow.source), 'utf8');
          if (asset.id === 'quality-gate-platforms') workflow += readFileSync(path.join(repositoryRoot, registry.qualityPlatformsReusableWorkflow.source), 'utf8');
          for (const [, action, ref] of workflow.matchAll(actionUse)) {
            if (action.includes('/.github/workflows/')) continue;
            const target = registry.actionTargets
              .find((candidate) => `${registry.actionRepository}/${candidate.actionPath}` === action);
            expect(target, `unregistered a3 Action in ${asset.source}: ${action}`).toBeTruthy();
            const expectedRef = target.status === 'pending-release' ? registry.pendingActionRef : registry.actionExactRef;
            expect(ref, `unexpected ref in ${asset.source}`).toBe(expectedRef);
            observed.add(target.id);
          }
        }
        return { preset: preset.id, declared: [...declared].sort(), observed: [...observed].sort() };
      });
      // Assert
      expect(report.mismatches).toStrictEqual([]);
      for (const entry of coverage) {
        expect(entry.observed, `registry coverage mismatch: ${entry.preset}`).toStrictEqual(entry.declared);
      }
      expect(coverage.length > 0).toBeTruthy();
    });
  });
});

describe("contract.ci-preset-assurance.verification", () => {
  describe("preset-assurance-contract", () => {
    // integration_id: preset-assurance-contract
    // contract_id: contract.ci-preset-assurance.verification
    test('preflight rejects malformed adapter commands consistently with materializer and Action', () => {
      const base = [
        'schemaVersion: "1"',
        'kind: ci-adapter-bundle',
        'id: test-adapter',
        'contract: quality-scripts',
        'languageProfiles: [node]',
        'provider: provider-neutral',
        'executionBoundary: read-only',
        'sourceCheckout: fixed-source',
        'copyable: true',
        'owner: ci',
        'assets: []',
        'projectSettings:',
        '  requiredFiles: []',
        '  requiredScripts: []',
        '  requiredEnvironmentPaths: []',
        'toolchain:',
        '  versionEnv: CI_TOOLCHAIN_VERSION',
        '  verify:',
        '    command: node',
        '    args: [--version]',
        'preparation:',
        '  - command: node',
        '    args: [x]',
        'commands:',
        '  - command: node',
        '    args: [x]',
        '',
      ].join('\n');
      const cases = [
        { command: '  - null', message: 'command must be a mapping' },
        { command: '  - command: ""\n    args: [x]', message: 'command must be a non-empty string without NUL or line breaks' },
        { command: '  - command: node\n    args: [1]', message: 'command args must be a non-empty string list without NUL or line breaks' },
        { command: '  - command: node\n    args: []', message: 'command args must be a non-empty string list without NUL or line breaks' },
        { command: '  - id: "a\\nb"\n    command: node\n    args: [x]', message: 'command id must be a non-empty string without NUL or line breaks' },
        { command: '  - id: same\n    command: node\n    args: [x]\n  - id: same\n    command: node\n    args: [x]', message: 'command ids must be unique within the descriptor' },
      ];
      for (const testCase of cases) {
        const root = mkdtempSync(path.join(repositoryRoot, 'tmp/ci-descriptor-invalid-'));
        try {
          mkdirSync(path.join(root, '.ci/adapters'), { recursive: true });
          writeFileSync(
            path.join(root, '.ci/adapters/test-adapter.yml'),
            base.replace('commands:\n  - command: node\n    args: [x]', `commands:\n${testCase.command}`),
          );
          const report = createReport();
          validateDescriptor(root, '.ci/adapters/test-adapter.yml', report, {}, 'github');
          expect(report.mismatches.some((finding) => finding.message === testCase.message), `${testCase.message}: ${JSON.stringify(report.mismatches)}`).toBeTruthy();
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    });
  });
});

describe("preset-validation-contract", () => {
  describe("preset-assurance-contract", () => {
    // POSIX symlink setup is local evidence; Windows needs its own fixture.
    // evidence_role: supplemental
    // test_level: integration
    // integration_id: preset-assurance-contract
    test.runIf(process.platform !== 'win32')('preflight confines owner descriptor and required files to the consumer tree', () => withFixture((root) => {
      // Arrange
      const descriptor = ownerDescriptor(); const descriptorPath = '.ci/adapters/owner.yml';
      const external = path.join(root, 'external-control'); const consumer = path.join(root, 'consumer');
      mkdirSync(external); mkdirSync(path.join(consumer, '.ci/adapters'), { recursive: true }); mkdirSync(path.join(consumer, '.ci/scripts'));
      writeFileSync(path.join(external, 'descriptor.yml'), JSON.stringify(descriptor));
      writeFileSync(path.join(external, 'asset.mjs'), 'external asset');
      writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ scripts: { quality: 'node --version' } }));
      const descriptorFile = path.join(consumer, descriptorPath);
      const env = { CI_LANGUAGE_PROFILE: 'owner-profile', CI_OWNER_CONFIG: '.ci/owner.yml' };
      const cases = [
        ['missing descriptor', () => {}, () => {}, 'quality adapter descriptor is missing'],
        ['descriptor traversal', () => {}, () => {}, 'path escapes repository root', '../external-control/descriptor.yml'],
        ['descriptor symlink', () => fs.symlinkSync(path.join(external, 'descriptor.yml'), descriptorFile), () => fs.unlinkSync(descriptorFile), 'descriptor resolves outside'],
        ['asset symlink', () => { writeFileSync(descriptorFile, JSON.stringify(descriptor)); fs.symlinkSync(path.join(external, 'asset.mjs'), path.join(consumer, '.ci/scripts/owner-quality.mjs')); }, () => fs.unlinkSync(path.join(consumer, '.ci/scripts/owner-quality.mjs')), 'adapter asset resolves outside'],
        ['environment symlink', () => { fs.symlinkSync(path.join(external, 'asset.mjs'), path.join(consumer, '.ci/owner.yml')); }, () => fs.unlinkSync(path.join(consumer, '.ci/owner.yml')), 'required environment path resolves outside'],
        ['project symlink', () => { descriptor.projectSettings.requiredFiles = ['.ci/project-file']; writeFileSync(descriptorFile, JSON.stringify(descriptor)); fs.symlinkSync(path.join(external, 'asset.mjs'), path.join(consumer, '.ci/project-file')); }, () => fs.unlinkSync(path.join(consumer, '.ci/project-file')), 'required project file resolves outside'],
      ];
      for (const [label, prepare, restore, expected, selectedPath] of cases) {
        prepare();
        try {
          const before = snapshotTree(consumer); const report = createReport();
          // Act
          validateDescriptor(consumer, selectedPath ?? descriptorPath, report, env, 'github');
          // Assert
          expect([...report.mismatches, ...report.missingSettings].some((item) => item.message.includes(expected)), `${label}: ${JSON.stringify(report)}`).toBeTruthy();
          expect(snapshotTree(consumer), label).toStrictEqual(before);
        } finally { restore(); }
      }
    }));

    // evidence_role: supplemental
    // test_level: integration
    // integration_id: preset-assurance-contract
    test('preflight rejects standard implementation selection and workflow binding drift', () => withFixture((root) => {
      // Arrange
      const registry = loadRegistry(createReport()); const preset = registry.presets.find((p) => p.id === 'release-publication');
      const workflowPath = '.github/workflows/release-publication.yml';
      const workflow = parseYaml(readFileSync(path.join(repositoryRoot, '.github/workflows/ci-release-publication.yml'), 'utf8'), workflowPath);
      workflow.env.CI_RELEASE_IMPLEMENTATION = 'rust-cli-release'; workflow.env.CI_LANGUAGE_PROFILE = 'rust';
      for (const name of registry.standardImplementations[0].projectSettingsEnv) workflow.env[name] = 'project-value';
      workflow.env.CI_STANDARD_BUNDLE_ID = 'rust-cargo-quality';
      const cases = [
        ['valid', () => {}, undefined],
        ['selection missing', (w) => { delete w.env.CI_RELEASE_IMPLEMENTATION; }, 'release implementation selection is missing'],
        ['selection empty', (w) => { w.env.CI_RELEASE_IMPLEMENTATION = ''; }, 'release implementation selection is missing'],
        ['unknown selection', (w) => { w.env.CI_RELEASE_IMPLEMENTATION = 'owner-unknown'; }, 'release implementation is not registered'],
        ['profile type', (w) => { delete w.env.CI_LANGUAGE_PROFILE; }, 'does not support the selected language profile'],
        ['profile mismatch', (w) => { w.env.CI_LANGUAGE_PROFILE = 'python'; }, 'does not support the selected language profile'],
        ['setting absent', (w) => { delete w.env.CI_CARGO_MANIFEST_PATH; }, 'selected release implementation setting is missing'],
        ['setting empty', (w) => { w.env.CI_CARGO_LOCK_PATH = ' '; }, 'selected release implementation setting is missing'],
        ['disconnected action', (w) => { w.jobs.publish.steps = []; }, 'Action is not connected to the workflow'],
        ['dependency mismatch', (w) => { w.env.CI_STANDARD_BUNDLE_ID = 'other'; }, 'does not match the selected standard implementation dependency'],
      ];
      mkdirSync(path.dirname(path.join(root, workflowPath)), { recursive: true });
      for (const [label, mutate, expected] of cases) {
        const changed = structuredClone(workflow); mutate(changed);
        writeFileSync(path.join(root, workflowPath), JSON.stringify(changed));
        const before = snapshotTree(root); const report = createReport();
        // Act
        validateStandardImplementation({ root, registry, report, parsed: new Map([[workflowPath, changed]]) }, preset);
        // Assert
        const findings = [...report.missingSettings, ...report.mismatches];
        if (expected) expect(findings.some((item) => item.message.includes(expected)), `${label}: ${JSON.stringify(findings)}`).toBeTruthy();
        else expect(findings).toStrictEqual([]);
        expect(snapshotTree(root), label).toStrictEqual(before);
      }
    }));
  });
});

describe("preset-validation-contract", () => {
  describe("preset-registry-binding-validation", () => {
    // evidence_role: supplemental
    // test_level: integration
    // integration_id: preset-registry-binding-validation
    test('preflight reports incomplete standard and conditional registry bindings', () => withFixture((root) => {
      // Arrange
      const registryPath = path.join(repositoryRoot, 'skills/ci-github/assets/registry/ci-github-preset-assets.yml');
      const sourceRegistry = parseYaml(readFileSync(registryPath, 'utf8'), registryPath);
      const invalidRegistryCases = [
        ['static validation shape', (r) => { r.provider.staticValidation = {}; }, 'provider.staticValidation'],
        ['tool name', (r) => { r.provider.staticValidation[0].tool = ''; }, 'provider.staticValidation[0].tool'],
        ['settings ownership', (r) => { r.provider.staticValidation[0].ownership = 'provider'; }, 'provider.staticValidation[0].ownership'],
        ['config list', (r) => { r.provider.staticValidation[0].configPaths = []; }, 'provider.staticValidation[0].configPaths'],
        ['config escape', (r) => { r.provider.staticValidation[0].configPaths = ['../outside.yml']; }, 'provider.staticValidation[0].configPaths[0]'],
        ['action availability', (r) => { r.actionization.targets[0].status = 'unknown'; }, `actionization.targets.${sourceRegistry.actionization.targets[0].id}`],
        ['action release tag', (r) => { r.actionization.implementationSource.releaseTag = 'latest'; }, 'actionization.implementationSource.releaseTag'],
        ['action SHA', (r) => { r.actionization.implementationSource.exactRef = 'main'; }, 'actionization.implementationSource.exactRef'],
        ['action requirements', (r) => { r.actionization.availabilityGate.requires = []; }, 'actionization.availabilityGate.requires'],
      ];
      const read = fs.readFileSync;
      for (const [label, mutate, diagnosticPath] of invalidRegistryCases) {
        const malformed = structuredClone(sourceRegistry);
        mutate(malformed);
        const content = stringify(malformed);
        const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((filename, options) =>
          String(filename) === registryPath ? content : read(filename, options));
        const report = createReport();
        try {
          // Act
          loadRegistry(report);
          // Assert
          expect(report.mismatches.some((item) => item.path === diagnosticPath), label).toBe(true);
        } finally {
          spy.mockRestore();
        }
      }
      // Arrange
      const customWorkflow = { jobs: { custom: { 'runs-on': 'ubuntu-24.04', steps: [{ run: '.ci/scripts/entry.sh' }] } } };
      const customText = stringify(customWorkflow);
      const scripts = path.join(root, '.ci/scripts');
      mkdirSync(scripts, { recursive: true });
      writeFileSync(path.join(scripts, 'entry.sh'), 'python "${script_dir}/helper.py"\n');
      writeFileSync(path.join(scripts, 'helper.py'), 'import shared\n');
      writeFileSync(path.join(scripts, 'shared.py'), '# project-owned helper\n');
      const missingReport = createReport();
      const registryForCustom = loadRegistry(createReport());
      // Act
      const references = findWorkflowAssetReferences(root, customText);
      validateCommon(root, '.github/workflows/custom.yml', customText, customWorkflow, missingReport, registryForCustom);
      // Assert
      expect(references).toEqual(['.ci/scripts/entry.sh', '.ci/scripts/helper.py', '.ci/scripts/shared.py']);
      expect(missingReport.missingSettings.some((item) => references.includes(item.path))).toBe(false);
      // Arrange
      fs.unlinkSync(path.join(scripts, 'helper.py'));
      const absentWorkflow = { jobs: { custom: { 'runs-on': 'ubuntu-24.04', steps: [{ run: '.ci/scripts/entry.sh' }] } } };
      const absentReport = createReport();
      // Act
      validateCommon(root, '.github/workflows/custom.yml', stringify(absentWorkflow), absentWorkflow, absentReport, registryForCustom);
      // Assert
      expect(absentReport.missingSettings.some((item) => item.path === '.ci/scripts/helper.py')).toBe(true);
      writeFileSync(path.join(scripts, 'helper.py'), 'import shared\n');
      const original = loadRegistry(createReport()); const originalPreset = original.presets.find((p) => p.id === 'release-publication');
      const workflowPath = '.github/workflows/release-publication.yml';
      const workflow = parseYaml(readFileSync(path.join(repositoryRoot, '.github/workflows/ci-release-publication.yml'), 'utf8'), workflowPath);
      workflow.env.CI_RELEASE_IMPLEMENTATION = 'rust-cli-release'; workflow.env.CI_LANGUAGE_PROFILE = 'rust'; workflow.env.CI_STANDARD_BUNDLE_ID = 'rust-cargo-quality';
      for (const name of original.standardImplementations[0].projectSettingsEnv) workflow.env[name] = 'project-value';
      const cases = [
        ['missing binding', (r) => { delete r.standardImplementations[0].fulfillsExtensions['release-build-adapter']; }, 'does not fulfill a required binding'],
        ['extra binding', (r) => { r.standardImplementations[0].fulfillsExtensions.extra = 'ci-release-publisher'; }, 'not required by the preset'],
        ['unknown action', (r) => { r.standardImplementations[0].fulfillsExtensions['release-build-adapter'] = 'unknown'; }, 'Action binding is not registered'],
        ['unknown dependency', (r) => { r.standardImplementations[0].dependencies = [{ kind: 'adapter-bundle', id: 'unknown' }]; }, 'dependency is not registered'],
        ['unsupported dependency kind', (r) => { r.standardImplementations[0].dependencies = [{ kind: 'other', id: 'rust-cargo-quality' }]; }, 'dependency is not registered'],
      ];
      for (const [label, mutate, expected] of cases) {
        const registry = structuredClone(original); mutate(registry); const report = createReport(); const before = snapshotTree(root);
        // Act
        validateStandardImplementation({ root, registry, report, parsed: new Map([[workflowPath, workflow]]) }, originalPreset);
        // Assert
        expect([...report.mismatches, ...report.missingSettings].some((item) => item.message.includes(expected)), label).toBeTruthy();
        expect(snapshotTree(root), label).toStrictEqual(before);
      }
      const extension = originalPreset.assets.conditionalExtensions[0]; const callerPath = originalPreset.workflowAssets.find((a) => a.id === extension.workflowAsset).destination;
      const caller = { jobs: { publish: { with: { supplemental_release_asset_enabled: false } } } };
      const conditionalCases = [
        ['unconditional duplicate', (r, p) => { p.assets.requiredExtensions.push(extension.id); }, 'must not also be an unconditional preset asset'],
        ['copyable duplicate', (r, p) => { p.assets.copyable.push(extension.id); }, 'must not also be an unconditional preset asset'],
        ['unknown extension', (r) => { r.registeredAssets = r.registeredAssets.filter((a) => a.id !== extension.id); }, 'must resolve to one project-owned registered asset'],
        ['copyable extension', (r) => { r.registeredAssets.find((a) => a.id === extension.id).copyable = true; }, 'must resolve to one project-owned registered asset'],
        ['missing selector workflow', (r, p) => { p.workflowAssets = []; }, 'selector workflow is missing'],
      ];
      for (const [label, mutate, expected] of conditionalCases) {
        const registry = structuredClone(original); const preset = structuredClone(originalPreset); mutate(registry, preset);
        const before = snapshotTree(root); const report = createReport();
        // Act
        validateConditionalExtensions({ root, registry, report, parsed: new Map([[callerPath, caller]]) }, preset);
        // Assert
        expect([...report.mismatches, ...report.missingSettings].some((item) => item.message.includes(expected)), label).toBeTruthy();
        expect(snapshotTree(root), label).toStrictEqual(before);
      }
    }));
  });
});

describe("preset-validation-contract", () => {
  describe("preset-assurance-contract", () => {
    // Executable-bit refusals require POSIX filesystem semantics.
    // evidence_role: supplemental
    // test_level: integration
    // integration_id: preset-assurance-contract
    test.runIf(process.platform !== 'win32')('preflight verifies enabled conditional owner extensions without changing consumer assets', () => withFixture((root) => {
      // Arrange
      const registry = loadRegistry(createReport()); const preset = registry.presets.find((p) => p.id === 'release-publication');
      const extension = preset.assets.conditionalExtensions[0]; const asset = preset.workflowAssets.find((a) => a.id === extension.workflowAsset);
      const registered = registry.registeredAssets.find((a) => a.id === extension.id);
      const entrypoint = registered.entrypoints[0]; const filename = path.join(root, entrypoint);
      const caller = parseYaml(readFileSync(path.join(repositoryRoot, asset.source), 'utf8'), asset.source);
      caller.jobs.publish.with.supplemental_release_asset_implementation = 'owner-adapter';
      caller.jobs.publish.with.supplemental_release_asset_config_path = '__unset__';
      caller.jobs.publish.with.release_skills_config_path = '__unset__';
      const request = preset.workflowAssets.find(a => a.id === 'release-publication-request');
      writeFileSync(path.join(root, request.destination), readFileSync(path.join(repositoryRoot, request.source), 'utf8'));
      mkdirSync(path.dirname(filename), { recursive: true });
      const cases = [
        ['enabled executable', true, 'file', 0o755, true, undefined],
        ['disabled', false, 'missing', 0, false, undefined],
        ['standard installer needs no owner adapter', true, 'missing', 0, true, undefined, 'standard-installer'],
        ['dynamic selector', '${{ inputs.enabled }}', 'missing', 0, false, 'selector must be a static boolean'],
        ['missing selector', undefined, 'missing', 0, false, 'selector must be a static boolean'],
        ['unreachable', true, 'file', 0o755, false, 'not reachable from the preset workflow'],
        ['missing reachable entrypoint', true, 'missing', 0, true, 'entrypoint is missing'],
        ['directory entrypoint', true, 'directory', 0, true, 'entrypoint must be a regular file'],
        ['nonexecutable entrypoint', true, 'file', 0o644, true, 'entrypoint must be executable'],
      ];
      for (const [label, enabled, kind, mode, reachable, expected, implementation = 'owner-adapter'] of cases) {
        const changed = structuredClone(caller); changed.jobs.publish.with.supplemental_release_asset_enabled = enabled;
        changed.jobs.publish.with.supplemental_release_asset_implementation = implementation;
        if (!reachable) delete changed.jobs.publish.uses;
        if (kind === 'file') { writeFileSync(filename, 'project-owned extension'); fs.chmodSync(filename, mode); }
        if (kind === 'directory') mkdirSync(filename);
        writeFileSync(path.join(root, asset.destination), stringify(changed));
        const parsed = new Map([[asset.destination, changed]]);
        const before = snapshotTree(root); const report = createReport();
        const beforeMode = fs.existsSync(filename) ? fs.statSync(filename).mode : undefined;
        // Act
        validateConditionalExtensions({ root, registry, parsed, report }, preset);
        const preflight = validateCiPresetInternal({ repoRoot: root, presets: [preset.id] }, false);
        // Assert
        const findings = [...report.missingSettings, ...report.mismatches];
        if (expected) expect(findings.some((item) => item.message.includes(expected)), `${label}: ${JSON.stringify(findings)}`).toBeTruthy();
        else expect(findings, label).toStrictEqual([]);
        expect(preflight.missingSettings.some(item => item.path === entrypoint && item.message === 'enabled conditional extension entrypoint is missing'), label).toBe(enabled === true && implementation === 'owner-adapter' && kind === 'missing');
        expect(preflight.status).toBe('failed');
        expect(preflight.missingSettings.some(item => item.message.includes('publication reusable workflow is pending-release'))).toBe(true);
        expect(snapshotTree(root), label).toStrictEqual(before);
        if (beforeMode !== undefined) expect(fs.statSync(filename).mode, label).toBe(beforeMode);
        if (kind === 'directory') fs.rmdirSync(filename);
        if (kind === 'file') fs.unlinkSync(filename);
      }
    }));
  });
});
