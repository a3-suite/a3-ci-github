import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import { stringify } from 'yaml';
import path from 'node:path';
import { test, describe, expect } from 'vitest';
import { fileURLToPath } from 'node:url';

import { loadRegistry, parseYaml } from '../preset-registry.ts';
import { writeCiAssetLock } from '../ci-asset-lock-plan.ts';
import { createReport } from '../validation-report.ts';
import { validateQualityPreset } from '../quality-validation.ts';
import { inspectWorkflowAsset } from '../workflow-validation.ts';
import {
  loadReleaseRequestFixtureModel,
  snapshotTree,
  writeReleaseRequestFixture,
} from './support/release-request-fixture.mjs';
import { validateCiPresetCli, writeCiAssetLockCli } from './support/preset-cli.mjs';
import { ownerDescriptor } from './support/owner-descriptor-fixture.mjs';

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
    // contract_id: contract.ci-preset-assurance.asset-lock
    // contract_id: contract.ci-preset-assurance.verification
    test('asset lock generation rejects independent edits to unused approved pins', () => withFixture((root) => {
      const document = parseYaml(readFileSync(path.join(root, model.pinPath), 'utf8'), model.pinPath);
      const mutations = [
        (value) => { value['actions/checkout'].runtime = 'node20'; },
        (value) => { delete value['actions/checkout']; },
        (value) => { value['extra/action'] = { ...value['actions/checkout'] }; },
        (value) => { value['actions/checkout'].extra = 'undeclared'; },
      ];
      for (const mutate of mutations) {
        const changed = structuredClone(document);
        mutate(changed);
        writeFileSync(path.join(root, model.pinPath), stringify(changed));
        const before = snapshotTree(root);
        expect(validateCiPresetCli({ repoRoot: root, presets: ['release-request'] }).status).toBe('failed');
        expect(() => writeCiAssetLockCli({ repoRoot: root, sourceRevision: 'c'.repeat(40), releaseTag: 'v0.9.0' }))
          .toThrow(/"stage":"preset-validation".*"observed":"failed"/);
        expect(snapshotTree(root)).toStrictEqual(before);
      }
      writeFileSync(path.join(root, model.pinPath), JSON.stringify(Object.fromEntries(Object.entries(document).reverse())));
      expect(writeCiAssetLockCli({ repoRoot: root, sourceRevision: 'c'.repeat(40), releaseTag: 'v0.9.0' }).assets.some(entry => entry.path === model.pinPath)).toBe(true);
    }));
    // integration_id: preset-asset-lock-contract
    // contract_id: contract.ci-preset-assurance.asset-lock
    // evidence_role: contract
    // test_level: e2e
    test('asset lock generation records the source revision and canonical asset digests', () => withFixture((root) => {
      // Arrange
      const sourceRevision = 'c'.repeat(40);
      const minute = (date) => `${date.toISOString().slice(0, 16)}Z`;
      const startedAt = minute(new Date());
      // Act
      const lock = writeCiAssetLockCli({ repoRoot: root, sourceRevision, releaseTag: 'v0.9.0' });
      const finishedAt = minute(new Date());
      // Assert
      expect(lock.sourceRevision).toBe(sourceRevision);
      expect(lock.releaseTag).toBe('v0.9.0');
      // The CLI stamps its run time truncated to the minute, so it lies between the minutes around the run.
      expect(lock.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/);
      expect(lock.generatedAt >= startedAt && lock.generatedAt <= finishedAt, lock.generatedAt).toBe(true);
      expect(lock.assets.map((asset) => asset.path).sort()).toStrictEqual([...releaseRequestAssets.map((asset) => asset.destination), model.pinPath].sort());
      const pins = lock.assets.find((asset) => asset.path === model.pinPath);
      expect(pins.canonicalSha256).toBe(model.sha256(readFileSync(path.join(repositoryRoot, 'skills/ci-github/assets/registry/ci-github-preset-assets.yml'))));
      expect(pins.appliedSha256).toBe(model.sha256(readFileSync(path.join(root, model.pinPath))));
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
    // test_level: e2e
    test('preset assurance validates a canonical preset without modifying the consumer project', () => withFixture((root) => {
      // Arrange
      writeCiAssetLock({
        repoRoot: root,
        sourceRevision: 'c'.repeat(40),
        releaseTag: 'v0.9.0',
        generatedAt: '2026-09-17T00:41:59Z',
      });
      const before = snapshotTree(root);
      // Act
      const report = validateCiPresetCli({ repoRoot: root, presets: ['release-request'] });
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
        releaseTag: 'v0.9.0',
        generatedAt: '2026-09-17T00:41:59Z',
      });
      const workflowPath = path.join(root, '.github/workflows/release-request-tag.yml');
      const canonical = model.configureWorkflow(readFileSync(
        path.join(repositoryRoot, 'workflows/release/release-request-tag.yml'),
        'utf8',
      ));
      writeFileSync(workflowPath, canonical.replace('contents: read', 'contents: write'));
      const permissionDrift = snapshotTree(root);

      const permissionReport = validateCiPresetCli({ repoRoot: root, presets: ['release-request'] });
      expect(permissionReport.status).toBe('failed');
      expect(permissionReport.mismatches.some((finding) => finding.path.includes('permissions.contents'))).toBeTruthy();
      expect(snapshotTree(root)).toStrictEqual(permissionDrift);

      writeFileSync(workflowPath, canonical);
      writeFileSync(path.join(root, model.pinPath), model.pinDocument.replace(
        model.actionPins.get('actions/upload-artifact'),
        'd'.repeat(40),
      ));
      const pinDrift = snapshotTree(root);
      const pinReport = validateCiPresetCli({ repoRoot: root, presets: ['release-request'] });
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
        const rejected = validateCiPresetCli({ repoRoot: root, presets: ['release-request'] });
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
        releaseTag: 'v0.9.0',
        generatedAt: '2026-09-17T00:41:59Z',
      });
      const lockPath = path.join(root, '.ci/ci-assets.lock.json');
      const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
      const canonicalSha256 = lock.assets[0].canonicalSha256;
      lock.assets[0].canonicalSha256 = '0'.repeat(64);
      writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
      const before = snapshotTree(root);

      const report = validateCiPresetCli({ repoRoot: root, presets: ['release-request'] });
      expect(report.status).toBe('failed');
      expect(report.mismatches.some((finding) => finding.message.includes('canonical digest'))).toBeTruthy();
      expect(snapshotTree(root)).toStrictEqual(before);

      // Arrange
      lock.assets[0].canonicalSha256 = canonicalSha256;
      const cases = [
        [(value) => { value.schemaVersion = 'unsupported'; }, 'schemaVersion is unsupported'],
        [(value) => { value.kind = 'unsupported'; }, 'kind is unsupported'],
        [(value) => { value.sourceRevision = 42; }, 'full commit SHA'],
        [(value) => { value.sourceRevision = 'not-a-sha'; }, 'full commit SHA'],
        [(value) => { delete value.releaseTag; }, 'exact vX.Y.Z tag'],
        [(value) => { value.releaseTag = '0.9.0'; }, 'exact vX.Y.Z tag'],
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
        const rejected = validateCiPresetCli({ repoRoot: root, ...(message === 'unmanaged asset' ? {} : { presets: ['release-request'] }) });
        // Assert
        expect(rejected.status, message).toBe('failed');
        expect([...rejected.mismatches, ...rejected.missingSettings].some((finding) => finding.message.includes(message)), message).toBeTruthy();
        expect(snapshotTree(root)).toStrictEqual(snapshot);
      }
      // Arrange
      writeFileSync(lockPath, '{');
      // Act
      const malformed = validateCiPresetCli({ repoRoot: root, presets: ['release-request'] });
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
      const lockPath = path.join(root, '.ci/ci-assets.lock.json');
      const rejectInvalidRevision = () => expect(() => writeCiAssetLockCli({
        repoRoot: root, sourceRevision: 'not-a-full-sha', releaseTag: 'v0.9.0',
      })).toThrow(/"stage":"source-revision-validation"/);
      rejectInvalidRevision();
      expect(existsSync(lockPath)).toBe(false);

      writeCiAssetLockCli({ repoRoot: root, sourceRevision: 'c'.repeat(40), releaseTag: 'v0.9.0' });
      const before = readFileSync(lockPath);
      rejectInvalidRevision();
      expect(readFileSync(lockPath)).toStrictEqual(before);
    }));

    // integration_id: preset-asset-lock-contract
    // An empty value is already rejected while the CLI arguments are read, before the tag itself is validated.
    test.each([['', 'input-validation'], ['0.9.0', 'release-tag-validation'], ['v0.9', 'release-tag-validation'], ['latest', 'release-tag-validation']])('asset lock generation rejects the release tag %j', (releaseTag, stage) => withFixture((root) => {
      const lockPath = path.join(root, '.ci/ci-assets.lock.json');
      const options = { repoRoot: root, sourceRevision: 'c'.repeat(40) };
      const rejectInvalidTag = () => expect(() => writeCiAssetLockCli({ ...options, releaseTag }))
        .toThrow(new RegExp(`"stage":"${stage}"`));
      rejectInvalidTag();
      expect(existsSync(lockPath)).toBe(false);

      writeCiAssetLockCli({ ...options, releaseTag: 'v0.9.0' });
      const before = readFileSync(lockPath);
      rejectInvalidTag();
      expect(readFileSync(lockPath)).toStrictEqual(before);
    }));
  });
});

describe("contract.ci-preset-assurance.verification", () => {
  describe("preset-assurance-contract", () => {
    // evidence_role: contract
    // test_level: e2e
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
          const publicReport = validateCiPresetCli({ repoRoot: root, presets: ['quality-gate'] });
          expect(publicReport.status, label).toBe('failed');
          expect([...publicReport.missingSettings, ...publicReport.mismatches].some((item) => item.message.includes(expected)), label).toBeTruthy();
        }
        expect(snapshotTree(root), label).toStrictEqual(before);
      }
    }));
  });
});

describe("contract.ci-preset-assurance.verification", () => {
  describe("preset-assurance-contract", () => {
    // evidence_role: contract
    // test_level: e2e
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
          const publicReport = validateCiPresetCli({ repoRoot: root, presets: ['quality-gate'] });
          expect(publicReport.status, label).toBe('failed');
          expect(publicReport.mismatches.some((item) => item.path === `${asset.destination}:on.${event}` && item.message.startsWith('registered trigger extension')), label).toBeTruthy();
        }
        expect(snapshotTree(root), label).toStrictEqual(before);
      }
    }));
  });
});

