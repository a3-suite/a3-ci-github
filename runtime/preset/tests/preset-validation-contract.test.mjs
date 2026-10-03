import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';

import { loadRegistry, parseYaml } from '../preset-registry.ts';
import { validateCiPreset } from '../validate-ci-preset.ts';
import { writeCiAssetLock } from '../ci-asset-lock-plan.ts';
import { validateDescriptor } from '../descriptor-validation.ts';
import { createReport } from '../validation-report.ts';
import { validateQualityPreset, validateStandardImplementation, validateConditionalExtensions } from '../quality-validation.ts';
import { inspectWorkflowAsset } from '../workflow-validation.ts';
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
assert.deepEqual(model.preset.assets?.copyable ?? [], []);
const withFixture = (callback) => {
  const root = mkdtempSync(path.join(repositoryRoot, 'tmp/a3-ci-github-preset-contract-'));
  try {
    writeReleaseRequestFixture({ repositoryRoot, root, model });
    callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false);
  }
};

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
  assert.equal(lock.sourceRevision, sourceRevision);
  assert.equal(lock.generatedAt, '2026-09-17T00:41Z');
  assert.deepEqual(
    lock.assets.map((asset) => asset.path).sort(),
    releaseRequestAssets.map((asset) => asset.destination).sort(),
  );
  for (const asset of releaseRequestAssets) {
    const locked = lock.assets.find((entry) => entry.path === asset.destination);
    assert.ok(locked, `missing lock entry: ${asset.destination}`);
    assert.equal(locked.canonicalSha256, model.sha256(readFileSync(path.join(repositoryRoot, asset.source))));
    assert.equal(locked.appliedSha256, model.sha256(readFileSync(path.join(root, asset.destination))));
  }

}));

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
  assert.equal(report.status, 'success');
  assert.deepEqual(report.inspectedPresets, ['release-request']);
  assert.deepEqual(report.missingSettings, []);
  assert.deepEqual(report.mismatches, []);
  assert.ok(report.evidence.length > 0);
  assert.equal(report.semanticReviewRequired, true);
  assert.deepEqual(snapshotTree(root), before);
}));

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
  assert.equal(permissionReport.status, 'failed');
  assert.ok(permissionReport.mismatches.some((finding) => finding.path.includes('permissions.contents')));
  assert.deepEqual(snapshotTree(root), permissionDrift);

  writeFileSync(workflowPath, canonical);
  writeFileSync(path.join(root, model.pinPath), model.pinDocument.replace(
    model.actionPins.get('actions/upload-artifact'),
    'd'.repeat(40),
  ));
  const pinDrift = snapshotTree(root);
  const pinReport = validateCiPreset({ repoRoot: root, presets: ['release-request'] });
  assert.equal(pinReport.status, 'failed');
  assert.ok(pinReport.mismatches.some((finding) => finding.message.includes('approved pin')));
  assert.deepEqual(snapshotTree(root), pinDrift);

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
    assert.equal(rejected.status, 'failed');
    assert.ok(rejected.mismatches.some((finding) => finding.message.startsWith('canonical drift:')));
    assert.deepEqual(snapshotTree(root), before);
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
  assert.equal(report.status, 'failed');
  assert.ok(report.mismatches.some((finding) => finding.message.includes('canonical digest')));
  assert.deepEqual(snapshotTree(root), before);

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
    assert.equal(rejected.status, 'failed', message);
    assert.ok([...rejected.mismatches, ...rejected.missingSettings].some((finding) => finding.message.includes(message)), message);
    assert.deepEqual(snapshotTree(root), snapshot);
  }
  // Arrange
  writeFileSync(lockPath, '{');
  // Act
  const malformed = validateCiPreset({ repoRoot: root, presets: ['release-request'] });
  // Assert
  assert.ok(malformed.mismatches.some((finding) => finding.message.includes('not valid JSON')));
  assert.equal(readFileSync(lockPath, 'utf8'), '{');
}));

// integration_id: preset-asset-lock-contract
test('asset lock generation rejects a noncanonical source revision', () => withFixture((root) => {
  assert.throws(
    () => writeCiAssetLock({ repoRoot: root, sourceRevision: 'not-a-full-sha' }),
    /sourceRevision must be a full commit SHA/,
  );
  assert.equal(existsSync(path.join(root, '.ci/ci-assets.lock.json')), false);
}));

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
        assert.ok(target, `unregistered a3 Action in ${asset.source}: ${action}`);
        const expectedRef = target.status === 'pending-release' ? registry.pendingActionRef : registry.actionExactRef;
        assert.equal(ref, expectedRef, `unexpected ref in ${asset.source}`);
        observed.add(target.id);
      }
    }
    return { preset: preset.id, declared: [...declared].sort(), observed: [...observed].sort() };
  });
  // Assert
  assert.deepEqual(report.mismatches, []);
  for (const entry of coverage) {
    assert.deepEqual(entry.observed, entry.declared, `registry coverage mismatch: ${entry.preset}`);
  }
  assert.ok(coverage.length > 0);
});

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
      assert.ok(
        report.mismatches.some((finding) => finding.message === testCase.message),
        `${testCase.message}: ${JSON.stringify(report.mismatches)}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
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
    if (expected) assert.ok(findings.some((item) => item.message.includes(expected)), `${label}: ${JSON.stringify(findings)}`);
    else assert.deepEqual(findings, [], label);
    if (expected) {
      const publicReport = validateCiPreset({ repoRoot: root, presets: ['quality-gate'] });
      assert.equal(publicReport.status, 'failed', label);
      assert.ok([...publicReport.missingSettings, ...publicReport.mismatches].some((item) => item.message.includes(expected)), label);
    }
    assert.deepEqual(snapshotTree(root), before, label);
  }
}));

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
      assert.ok([...report.mismatches, ...report.missingSettings].some((item) => item.message.includes(expected)), `${label}: ${JSON.stringify(report)}`);
      assert.deepEqual(snapshotTree(consumer), before, label);
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
    if (expected) assert.ok(findings.some((item) => item.message.includes(expected)), `${label}: ${JSON.stringify(findings)}`);
    else assert.deepEqual(findings, []);
    assert.deepEqual(snapshotTree(root), before, label);
  }
}));

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
    assert.equal(report.mismatches.some((item) => item.path === `${asset.destination}:on.${event}` && item.message.startsWith('registered trigger extension')), rejected, label);
    if (rejected) {
      const publicReport = validateCiPreset({ repoRoot: root, presets: ['quality-gate'] });
      assert.equal(publicReport.status, 'failed', label);
      assert.ok(publicReport.mismatches.some((item) => item.path === `${asset.destination}:on.${event}` && item.message.startsWith('registered trigger extension')), label);
    }
    assert.deepEqual(snapshotTree(root), before, label);
  }
}));


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
  const caller = { jobs: { publish: { with: { supplemental_release_asset_enabled: true } } } };
  const publication = { jobs: { supplemental: { steps: [{ run: `bash ${entrypoint}` }] } } };
  mkdirSync(path.dirname(filename), { recursive: true });
  const cases = [
    ['enabled executable', true, 'file', 0o755, true, undefined],
    ['disabled', false, 'missing', 0, false, undefined],
    ['dynamic selector', '${{ inputs.enabled }}', 'missing', 0, false, 'selector must be a static boolean'],
    ['missing selector', undefined, 'missing', 0, false, 'selector must be a static boolean'],
    ['unreachable', true, 'file', 0o755, false, 'not reachable from the preset workflow'],
    ['missing reachable entrypoint', true, 'missing', 0, true, undefined],
    ['directory entrypoint', true, 'directory', 0, true, 'entrypoint must be a regular file'],
    ['nonexecutable entrypoint', true, 'file', 0o644, true, 'entrypoint must be executable'],
  ];
  for (const [label, enabled, kind, mode, reachable, expected] of cases) {
    const changed = structuredClone(caller); changed.jobs.publish.with.supplemental_release_asset_enabled = enabled;
    if (kind === 'file') { writeFileSync(filename, 'project-owned extension'); fs.chmodSync(filename, mode); }
    if (kind === 'directory') mkdirSync(filename);
    const parsed = new Map([[asset.destination, changed]]);
    if (reachable) parsed.set('.github/workflows/release-publication.yml', publication);
    const before = snapshotTree(root); const report = createReport();
    const beforeMode = fs.existsSync(filename) ? fs.statSync(filename).mode : undefined;
    // Act
    validateConditionalExtensions({ root, registry, parsed, report }, preset);
    // Assert
    const findings = [...report.missingSettings, ...report.mismatches];
    if (expected) assert.ok(findings.some((item) => item.message.includes(expected)), `${label}: ${JSON.stringify(findings)}`);
    else assert.deepEqual(findings, [], label);
    assert.deepEqual(snapshotTree(root), before, label);
    if (beforeMode !== undefined) assert.equal(fs.statSync(filename).mode, beforeMode, label);
    if (kind === 'directory') fs.rmdirSync(filename);
    if (kind === 'file') fs.unlinkSync(filename);
  }
}));

// evidence_role: supplemental
// test_level: integration
// integration_id: preset-registry-binding-validation
test('preflight reports incomplete standard and conditional registry bindings', () => withFixture((root) => {
  // Arrange
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
    assert.ok([...report.mismatches, ...report.missingSettings].some((item) => item.message.includes(expected)), label);
    assert.deepEqual(snapshotTree(root), before, label);
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
    assert.ok([...report.mismatches, ...report.missingSettings].some((item) => item.message.includes(expected)), label);
    assert.deepEqual(snapshotTree(root), before, label);
  }
}));
