import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import { stringify } from 'yaml';
import path from 'node:path';
import { test, describe, expect, vi } from 'vitest';
import { fileURLToPath } from 'node:url';

import { loadRegistry, parseYaml } from '../preset-registry.ts';
import { validateCiPreset } from '../validate-ci-preset.ts';
import { validateCiPresetInternal } from '../validate-ci-preset-core.ts';
import { writeCiAssetLock } from '../ci-asset-lock-plan.ts';
import { validateDescriptor } from '../descriptor-validation.ts';
import { createReport } from '../validation-report.ts';
import { validateQualityPreset, validateStandardImplementation, validateConditionalExtensions } from '../quality-validation.ts';
import { inspectWorkflowAsset, validateCommon } from '../workflow-validation.ts';
import { findWorkflowAssetReferences } from '../workflow-assets.ts';
import {
  loadReleaseRequestFixtureModel,
  snapshotTree,
  writeReleaseRequestFixture,
} from './support/release-request-fixture.mjs';

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testRoot, '../../..');
const runtimeRoot = process.env.CI_GITHUB_PREFLIGHT_RUNTIME_ROOT ?? path.resolve(testRoot, '..');
const model = loadReleaseRequestFixtureModel({ repositoryRoot, runtimeRoot });
const releaseRequestAssets = [...(model.preset.workflowAssets ?? [])];
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

describe("contract.ci-preset-assurance.asset-lock", () => {
  describe("preset-asset-lock-contract", () => {
    // integration_id: preset-asset-lock-contract
    // contract_id: contract.ci-preset-assurance.asset-lock
    // evidence_role: contract
    // test_level: integration
    test('asset lock generation records the source revision and canonical asset digests', () => withFixture((root) => {
      // Arrange
      const sourceRevision = 'c'.repeat(40);
      // Act
      const lock = writeCiAssetLock({
        repoRoot: root,
        sourceRevision,
        generatedAt: '2026-09-17T00:41:59Z',
      });
      // Assert
      expect(lock.sourceRevision).toBe(sourceRevision);
      expect(lock.generatedAt).toBe('2026-09-17T00:41Z');
      expect(lock.assets.map((asset) => asset.path).sort()).toStrictEqual(releaseRequestAssets.map((asset) => asset.destination).sort());
      for (const asset of releaseRequestAssets) {
        const locked = lock.assets.find((entry) => entry.path === asset.destination);
        expect(locked, `missing lock entry: ${asset.destination}`).toBeTruthy();
        expect(locked.canonicalSha256).toBe(model.sha256(readFileSync(path.join(repositoryRoot, asset.source))));
        expect(locked.appliedSha256).toBe(model.sha256(readFileSync(path.join(root, asset.destination))));
      }

    }));
  });
});

describe("contract.ci-preset-assurance.verification", () => {
  describe("preset-assurance-contract", () => {
    // integration_id: preset-assurance-contract
    // contract_id: contract.ci-preset-assurance.verification
    // evidence_role: contract
    // test_level: integration
    test('preset assurance validates a canonical preset without modifying the consumer project', () => withFixture((root) => {
      // Arrange
      writeCiAssetLock({
        repoRoot: root,
        sourceRevision: 'c'.repeat(40),
        generatedAt: '2026-09-17T00:41:59Z',
      });
      const before = snapshotTree(root);
      // Act
      const report = validateCiPreset({ repoRoot: root, presets: ['release-request'] });
      // Assert
      expect(report.status).toBe('success');
      expect(report.inspectedPresets).toStrictEqual(['release-request']);
      expect(report.missingSettings).toStrictEqual([]);
      expect(report.mismatches).toStrictEqual([]);
      expect(report.evidence.length > 0).toBeTruthy();
      expect(report.semanticReviewRequired).toBe(true);
      expect(snapshotTree(root)).toStrictEqual(before);
    }));
  });
});

describe("preset-validation-contract", () => {
  describe("preset-assurance-contract", () => {
    // integration_id: preset-assurance-contract
    test('preset assurance reports canonical drift without modifying the consumer project', () => withFixture((root) => {
      writeCiAssetLock({
        repoRoot: root,
        sourceRevision: 'c'.repeat(40),
        generatedAt: '2026-09-17T00:41:59Z',
      });
      const workflowPath = path.join(root, '.github/workflows/release-request-tag.yml');
      const canonical = model.configureWorkflow(readFileSync(
        path.join(repositoryRoot, 'workflows/release/release-request-tag.yml'),
        'utf8',
      ));
      writeFileSync(workflowPath, canonical.replace('contents: read', 'contents: write'));
      const permissionDrift = snapshotTree(root);

      const permissionReport = validateCiPreset({ repoRoot: root, presets: ['release-request'] });
      expect(permissionReport.status).toBe('failed');
      expect(permissionReport.mismatches.some((finding) => finding.path.includes('permissions.contents'))).toBeTruthy();
      expect(snapshotTree(root)).toStrictEqual(permissionDrift);

      writeFileSync(workflowPath, canonical);
      writeFileSync(path.join(root, model.pinPath), model.pinDocument.replace(
        model.actionPins.get('actions/upload-artifact'),
        'd'.repeat(40),
      ));
      const pinDrift = snapshotTree(root);
      const pinReport = validateCiPreset({ repoRoot: root, presets: ['release-request'] });
      expect(pinReport.status).toBe('failed');
      expect(pinReport.mismatches.some((finding) => finding.message.includes('approved pin'))).toBeTruthy();
      expect(snapshotTree(root)).toStrictEqual(pinDrift);

      // Arrange
      writeFileSync(path.join(root, model.pinPath), model.pinDocument);
      const configured = parseYaml(canonical, 'canonical fixture');
      const mutations = [
        (value) => { delete value.permissions; },
        (value) => { value.permissions = ['read']; },
        (value) => { value.permissions.extra = 'read'; },
        (value) => { value.on = null; },
        (value) => { value.on.push.tags = []; },
        (value) => { value.on.push.tags = [123]; },
        (value) => { value.jobs = []; },
        (value) => { const job = Object.values(value.jobs)[0]; job.steps = null; },
        (value) => { const job = Object.values(value.jobs)[0]; job.steps.pop(); },
        (value) => { const job = Object.values(value.jobs)[0]; job.steps[0].uses = 'a3-suite/a3-ci-github/actions/unregistered@' + 'a'.repeat(40); },
        (value) => { const job = Object.values(value.jobs)[0]; job.steps[0].with = { ref: { invalid: 'mapping' } }; },
      ];
      for (const mutate of mutations) {
        const changed = structuredClone(configured);
        mutate(changed);
        writeFileSync(workflowPath, JSON.stringify(changed));
        const before = snapshotTree(root);
        // Act
        const rejected = validateCiPreset({ repoRoot: root, presets: ['release-request'] });
        // Assert
        expect(rejected.status).toBe('failed');
        expect(rejected.mismatches.some((finding) => finding.message.startsWith('canonical drift:'))).toBeTruthy();
        expect(snapshotTree(root)).toStrictEqual(before);
      }
    }));

    // integration_id: preset-assurance-contract
    test('preset assurance rejects an asset lock digest drift without remediation', () => withFixture((root) => {
      writeCiAssetLock({
        repoRoot: root,
        sourceRevision: 'c'.repeat(40),
        generatedAt: '2026-09-17T00:41:59Z',
      });
      const lockPath = path.join(root, '.ci/ci-assets.lock.json');
      const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
      lock.assets[0].canonicalSha256 = '0'.repeat(64);
      writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
      const before = snapshotTree(root);

      const report = validateCiPreset({ repoRoot: root, presets: ['release-request'] });
      expect(report.status).toBe('failed');
      expect(report.mismatches.some((finding) => finding.message.includes('canonical digest'))).toBeTruthy();
      expect(snapshotTree(root)).toStrictEqual(before);

      // Arrange
      lock.assets[0].canonicalSha256 = model.sha256(readFileSync(path.join(repositoryRoot, releaseRequestAssets[0].source)));
      const cases = [
        [(value) => { value.schemaVersion = 'unsupported'; }, 'schemaVersion is unsupported'],
        [(value) => { value.kind = 'unsupported'; }, 'kind is unsupported'],
        [(value) => { value.sourceRevision = 42; }, 'full commit SHA'],
        [(value) => { value.sourceRevision = 'not-a-sha'; }, 'full commit SHA'],
        [(value) => { value.generatedAt = '2026-99-99T00:00Z'; }, 'valid UTC timestamp'],
        [(value) => { value.generatedAt = 'invalid'; }, 'valid UTC timestamp'],
        [(value) => { delete value.assets; }, 'integrity assets are missing'],
        [(value) => { value.assets = []; }, 'asset is missing from'],
        [(value) => { value.assets.push({ ...value.assets[0] }); }, 'unique non-empty strings'],
        [(value) => { value.assets[0].path = ''; }, 'unique non-empty strings'],
        [(value) => { value.assets[0].path = 123; }, 'unique non-empty strings'],
        [(value) => { value.assets.push({ path: '.ci/unmanaged' }); }, 'unmanaged asset'],
        [(value) => { value.assets[0].canonicalSha256 = null; }, 'canonical digest'],
        [(value) => { value.assets[0].appliedSha256 = '0'.repeat(64); }, 'applied digest'],
        [(value) => { value.assets[0].appliedSha256 = 'bad'; }, 'applied digest'],
      ];
      for (const [mutate, message] of cases) {
        const changed = structuredClone(lock);
        mutate(changed);
        writeFileSync(lockPath, JSON.stringify(changed));
        const snapshot = snapshotTree(root);
        // Act
        const rejected = validateCiPreset({ repoRoot: root, ...(message === 'unmanaged asset' ? {} : { presets: ['release-request'] }) });
        // Assert
        expect(rejected.status, message).toBe('failed');
        expect([...rejected.mismatches, ...rejected.missingSettings].some((finding) => finding.message.includes(message)), message).toBeTruthy();
        expect(snapshotTree(root)).toStrictEqual(snapshot);
      }
      // Arrange
      writeFileSync(lockPath, '{');
      // Act
      const malformed = validateCiPreset({ repoRoot: root, presets: ['release-request'] });
      // Assert
      expect(malformed.mismatches.some((finding) => finding.message.includes('not valid JSON'))).toBeTruthy();
      expect(readFileSync(lockPath, 'utf8')).toBe('{');
    }));
  });
});

describe("preset-validation-contract", () => {
  describe("preset-asset-lock-contract", () => {
    // integration_id: preset-asset-lock-contract
    test('asset lock generation rejects a noncanonical source revision', () => withFixture((root) => {
      expect(() => writeCiAssetLock({ repoRoot: root, sourceRevision: 'not-a-full-sha' })).toThrow(/sourceRevision must be a full commit SHA/);
      expect(existsSync(path.join(root, '.ci/ci-assets.lock.json'))).toBe(false);
    }));
  });
});

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
        if (['release-publication', 'package-publication'].includes(preset.id)) installed.add(preset.id);
        const declared = new Set(registry.actionTargets
          .filter((target) => target.workflows.some((workflow) => installed.has(workflow)))
          .map((target) => target.id));
        const observed = new Set();
        for (const asset of assets) {
          let workflow = readFileSync(path.join(repositoryRoot, asset.source), 'utf8');
          if (asset.id === 'release-publication-caller') workflow += readFileSync(path.join(repositoryRoot, registry.releasePublicationReusableWorkflow.source), 'utf8');
          if (asset.id === 'package-publication-caller') workflow += readFileSync(path.join(repositoryRoot, registry.packagePublicationReusableWorkflow.source), 'utf8');
          if (asset.id === 'quality-gate') workflow += readFileSync(path.join(repositoryRoot, registry.qualityReusableWorkflow.source), 'utf8');
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


const ownerDescriptor = () => ({
  schemaVersion: '1', kind: 'ci-adapter-bundle', id: 'owner-quality', contract: 'quality-scripts',
  languageProfiles: ['owner-profile'], provider: 'provider-neutral', executionBoundary: 'read-only',
  sourceCheckout: 'fixed-source', copyable: true, owner: 'project',
  assets: [{ destination: '.ci/scripts/owner-quality.mjs' }],
  projectSettings: { requiredFiles: ['package.json'], requiredScripts: ['quality'], requiredEnvironmentPaths: ['CI_OWNER_CONFIG'] },
  toolchain: { versionEnv: 'CI_TOOLCHAIN_VERSION', verify: { id: 'version', command: 'node', args: ['--version'] } },
  preparation: [{ id: 'prepare', command: 'node' }], commands: [{ id: 'quality', command: 'node' }],
});

describe("contract.ci-preset-assurance.verification", () => {
  describe("preset-assurance-contract", () => {
    // evidence_role: contract
    // test_level: integration
    // integration_id: preset-assurance-contract
    // contract_id: contract.ci-preset-assurance.verification
    test('preflight validates owner descriptor settings and rejects malformed content without remediation', () => withFixture((root) => {
      // Arrange
      const registry = loadRegistry(createReport());
      const preset = registry.presets.find((entry) => entry.id === 'quality-gate');
      const workflowPath = preset.workflowAssets[0].destination;
      const descriptorPath = '.ci/adapters/owner.yml';
      const descriptorFile = path.join(root, descriptorPath);
      mkdirSync(path.dirname(descriptorFile), { recursive: true });
      mkdirSync(path.dirname(path.join(root, workflowPath)), { recursive: true });
      mkdirSync(path.join(root, '.ci/scripts'), { recursive: true });
      writeFileSync(path.join(root, '.ci/scripts/owner-quality.mjs'), 'project-owned quality');
      writeFileSync(path.join(root, '.ci/owner.yml'), 'project-owned settings');
      const project = { scripts: { quality: 'npm run check', check: 'node --version' } };
      const workflow = { env: { CI_LANGUAGE_PROFILE: 'owner-profile', CI_ADAPTER_DESCRIPTOR: descriptorPath, CI_OWNER_CONFIG: '.ci/owner.yml' },
        jobs: { quality: { steps: [{ run: 'node .ci/scripts/owner-quality.mjs' }] } } };
      const cases = [
        ['valid', () => {}, undefined],
        ['schema', (d) => { d.schemaVersion = '2'; }, 'schemaVersion must be 1'],
        ['missing identity', (d) => { delete d.id; }, 'id is missing'],
        ['empty identity', (d) => { d.owner = ''; }, 'owner is missing'],
        ['no profiles', (d) => { d.languageProfiles = []; }, 'languageProfiles is missing'],
        ['wrong profile', (d) => { d.languageProfiles = ['other']; }, 'does not support the selected language profile'],
        ['wrong provider', (d) => { d.provider = 'other'; }, 'does not support the selected CI provider'],
        ['source tree', (d) => { d.assets[0].source = 'skills/private'; }, 'must not reference a source skill tree'],
        ['destination type', (d) => { d.assets[0].destination = 42; }, 'asset destination must be project-local'],
        ['destination traversal', (d) => { d.assets[0].destination = '.ci/../outside'; }, 'asset destination must be project-local'],
        ['missing asset', (d) => { d.assets[0].destination = '.ci/missing.mjs'; }, 'adapter asset is missing'],
        ['no assets', (d) => { delete d.assets; }, undefined],
        ['settings declaration', (d) => { d.projectSettings.requiredFiles = null; }, 'projectSettings must declare'],
        ['environment name', (d) => { d.projectSettings.requiredEnvironmentPaths = ['OTHER']; }, 'valid workflow setting'],
        ['environment absent', (d, w) => { delete w.env.CI_OWNER_CONFIG; }, 'valid workflow setting'],
        ['environment empty', (d, w) => { w.env.CI_OWNER_CONFIG = ''; }, 'valid workflow setting'],
        ['environment absolute', (d, w) => { w.env.CI_OWNER_CONFIG = path.join(root, '.ci/owner.yml'); }, 'valid workflow setting'],
        ['environment traversal', (d, w) => { w.env.CI_OWNER_CONFIG = '../outside'; }, 'path escapes repository root'],
        ['environment missing file', (d, w) => { w.env.CI_OWNER_CONFIG = '.ci/missing.yml'; }, 'required environment path is missing'],
        ['environment directory', (d, w) => { w.env.CI_OWNER_CONFIG = '.ci'; }, 'required environment path is missing'],
        ['missing project file', (d) => { d.projectSettings.requiredFiles = ['missing.json']; }, 'required project file is missing'],
        ['project traversal', (d) => { d.projectSettings.requiredFiles = ['../outside']; }, 'path escapes repository root'],
        ['missing script', (d) => { d.projectSettings.requiredScripts = ['missing']; }, 'required project script is missing'],
        ['empty script', (d, w, pkg) => { pkg.scripts.quality = ' '; }, 'required project script must not be empty'],
        ['source script', (d, w, pkg) => { pkg.scripts.quality = 'node skills/private/run.mjs'; }, 'references the source skills tree'],
        ['cycle', (d, w, pkg) => { pkg.scripts.check = 'npm run quality'; }, 'delegation contains a cycle'],
        ['unrelated delegated command', (d, w, pkg) => { pkg.scripts.quality = 'npm exec external'; }, undefined],
        ['toolchain binding', (d) => { d.toolchain.versionEnv = 'OTHER'; }, 'must bind CI_TOOLCHAIN_VERSION'],
        ['toolchain command type', (d) => { d.toolchain.verify.command = 42; }, 'must bind CI_TOOLCHAIN_VERSION'],
        ['preparation missing', (d) => { delete d.preparation; }, 'dependency preparation is missing'],
        ['preparation empty', (d) => { d.preparation = []; }, 'dependency preparation is missing'],
        ['commands missing', (d) => { delete d.commands; }, 'quality commands are missing'],
        ['commands empty', (d) => { d.commands = []; }, 'quality commands are missing'],
        ['version id absent', (d) => { delete d.toolchain.verify.id; }, undefined],
        ['invalid package', (d, w, pkg) => { pkg.invalid = true; }, 'invalid project package.json'],
      ];
      for (const [label, mutate, expected] of cases) {
        const descriptor = ownerDescriptor(); const changed = structuredClone(workflow); const pkg = structuredClone(project);
        mutate(descriptor, changed, pkg);
        writeFileSync(descriptorFile, JSON.stringify(descriptor));
        writeFileSync(path.join(root, 'package.json'), pkg.invalid ? '{' : JSON.stringify(pkg));
        writeFileSync(path.join(root, workflowPath), JSON.stringify(changed));
        const before = snapshotTree(root); const report = createReport();
        // Act
        validateQualityPreset({ root, registry, report, parsed: new Map() }, preset);
        // Assert
        const findings = [...report.missingSettings, ...report.mismatches];
        if (expected) expect(findings.some((item) => item.message.includes(expected)), `${label}: ${JSON.stringify(findings)}`).toBeTruthy();
        else expect(findings, label).toStrictEqual([]);
        if (expected) {
          const publicReport = validateCiPreset({ repoRoot: root, presets: ['quality-gate'] });
          expect(publicReport.status, label).toBe('failed');
          expect([...publicReport.missingSettings, ...publicReport.mismatches].some((item) => item.message.includes(expected)), label).toBeTruthy();
        }
        expect(snapshotTree(root), label).toStrictEqual(before);
      }
    }));
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

describe("contract.ci-preset-assurance.verification", () => {
  describe("preset-assurance-contract", () => {
    // evidence_role: contract
    // test_level: integration
    // integration_id: preset-assurance-contract
    // contract_id: contract.ci-preset-assurance.verification
    test('preflight accepts registered quality trigger extensions and rejects malformed event settings', () => withFixture((root) => {
      // Arrange
      const registry = loadRegistry(createReport()); const preset = registry.presets.find((p) => p.id === 'quality-gate');
      const asset = preset.workflowAssets[0];
      const canonical = parseYaml(readFileSync(path.join(repositoryRoot, asset.source), 'utf8'), asset.source);
      const cases = [
        ['valid dispatch null', 'merge_group', null, false],
        ['valid dispatch map', 'merge_group', {}, false],
        ['dispatch scalar', 'merge_group', 'invalid', true],
        ['dispatch fields', 'merge_group', { inputs: {} }, true],
        ['valid schedule', 'schedule', [{ cron: '0 0 * * *' }], false],
        ['schedule scalar', 'schedule', 'invalid', true],
        ['schedule empty', 'schedule', [], true],
        ['schedule entry scalar', 'schedule', ['invalid'], true],
        ['schedule fields', 'schedule', [{ cron: '0 0 * * *', extra: true }], true],
        ['schedule wrong cron type', 'schedule', [{ cron: 42 }], true],
        ['schedule empty cron', 'schedule', [{ cron: ' ' }], true],
        ['schedule newline', 'schedule', [{ cron: '0 0 * * *\n' }], true],
      ];
      mkdirSync(path.dirname(path.join(root, asset.destination)), { recursive: true });
      for (const [label, event, value, rejected] of cases) {
        const workflow = structuredClone(canonical); workflow.on[event] = value;
        writeFileSync(path.join(root, asset.destination), JSON.stringify(workflow));
        const before = snapshotTree(root); const report = createReport();
        // Act
        inspectWorkflowAsset({ root, registry, report, parsed: new Map(), actionByPath: new Map(registry.actionTargets.map((t) => [`${registry.actionRepository}/${t.actionPath}`, t])) }, preset, asset, new Set());
        // Assert
        expect(report.mismatches.some((item) => item.path === `${asset.destination}:on.${event}` && item.message.startsWith('registered trigger extension')), label).toBe(rejected);
        if (rejected) {
          const publicReport = validateCiPreset({ repoRoot: root, presets: ['quality-gate'] });
          expect(publicReport.status, label).toBe('failed');
          expect(publicReport.mismatches.some((item) => item.path === `${asset.destination}:on.${event}` && item.message.startsWith('registered trigger extension')), label).toBeTruthy();
        }
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

describe("preset-validation-contract", () => {
  describe("preset-registry-binding-validation", () => {
    // evidence_role: supplemental
    // test_level: integration
    // integration_id: preset-registry-binding-validation
    test('preflight reports incomplete standard and conditional registry bindings', () => withFixture((root) => {
      // Arrange
      const registryPath = path.join(repositoryRoot, 'skills/ci-github/references/ci-github-preset-assets.reference.yml');
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
