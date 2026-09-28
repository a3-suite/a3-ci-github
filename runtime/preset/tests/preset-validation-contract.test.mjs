import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateCiPreset, writeCiAssetLock } from '../validate-ci-preset.ts';
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
  const root = mkdtempSync(path.join(os.tmpdir(), 'a3-ci-github-preset-contract-'));
  try {
    writeReleaseRequestFixture({ repositoryRoot, root, model });
    callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false);
  }
};

// integration_id: preset-assurance-contract
// integration_id: preset-asset-lock-contract
test('preset assurance validates a canonical preset and writes a deterministic asset lock', () => withFixture((root) => {
  const sourceRevision = 'c'.repeat(40);
  const lock = writeCiAssetLock({
    repoRoot: root,
    sourceRevision,
    generatedAt: '2026-09-17T00:41:59Z',
  });
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

  const before = snapshotTree(root);
  const report = validateCiPreset({ repoRoot: root, presets: ['release-request'] });
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
}));

// integration_id: preset-asset-lock-contract
test('asset lock generation rejects a noncanonical source revision', () => withFixture((root) => {
  assert.throws(
    () => writeCiAssetLock({ repoRoot: root, sourceRevision: 'not-a-full-sha' }),
    /sourceRevision must be a full commit SHA/,
  );
  assert.equal(existsSync(path.join(root, '.ci/ci-assets.lock.json')), false);
}));
