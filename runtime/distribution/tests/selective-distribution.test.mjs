import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  applyDistributionPlan,
  fetchDistribution,
  loadDistributionManifest,
  planDistributionApplication,
  resolveDistributionSelection,
  rollbackDistributionTransaction,
  validateDistributionManifest,
  verifyFetchedDistribution,
} from '../fetch-a3-ci-github.mjs';

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testRoot, '../../..');
const tsx = path.join(repositoryRoot, 'runtime/preset/node_modules/.bin/tsx');
const releaseTag = `v${fs.readFileSync(path.join(repositoryRoot, 'VERSION'), 'utf8').trim()}`;
const committedSourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'a3-ci-github-distribution-source-'));
for (const relative of [
  'VERSION',
  'skills/ci-github',
  'workflows',
  'runtime/preset',
  'runtime/platform',
  'runtime/adapter',
  'runtime/path',
  'runtime/vitest',
  'runtime/distribution',
  'lint-rules/a3-lint',
]) {
  const source = path.join(repositoryRoot, relative);
  const destination = path.join(committedSourceRoot, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, {
    recursive: true,
    filter: (candidate) => !candidate.split(path.sep).includes('node_modules'),
  });
}
const runFixtureGit = (args) => {
  const result = spawnSync('git', args, { cwd: committedSourceRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
runFixtureGit(['init', '-q']);
runFixtureGit(['config', 'user.name', 'Distribution Test']);
runFixtureGit(['config', 'user.email', 'distribution-test@example.invalid']);
runFixtureGit(['add', '--all']);
runFixtureGit(['commit', '-qm', 'fixture']);
const sourceRevision = runFixtureGit(['rev-parse', 'HEAD']);
test.after(() => fs.rmSync(committedSourceRoot, { recursive: true, force: true }));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const withFixture = async (name, callback) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), name));
  try {
    return await callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const prepareRelease = (root) => {
  const output = path.join(root, 'release');
  const result = spawnSync(tsx, [
    path.join(repositoryRoot, 'runtime/distribution/generate-distribution-release.ts'),
    '--repository-root', committedSourceRoot,
    '--output-directory', output,
    '--source-revision', sourceRevision,
    '--release-tag', releaseTag,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return {
    output,
    manifestPath: path.join(output, 'a3-ci-github-distribution-manifest.json'),
    manifestBytes: fs.readFileSync(path.join(output, 'a3-ci-github-distribution-manifest.json')),
    manifest: JSON.parse(fs.readFileSync(path.join(output, 'a3-ci-github-distribution-manifest.json'), 'utf8')),
  };
};

// contract_id: contract.ci-selective-distribution.delivery
test('release generator derives deterministic selective assets and checksums from registries', async () => {
  await withFixture('a3-ci-github-distribution-release-', (root) => {
    const first = prepareRelease(root);
    const manifest = validateDistributionManifest(first.manifest);
    assert.equal(manifest.sourceRevision, sourceRevision);
    assert.ok(manifest.assets.some((asset) => asset.id === 'runtime.preset'));
    assert.ok(manifest.assets.some((asset) => asset.id === 'workflow.quality-gate'));
    assert.ok(manifest.files['skills/ci-github/references/ci-script-contracts.reference.yml']);
    const quality = manifest.presets.find((preset) => preset.id === 'quality-gate');
    assert.ok(quality.requiredAssets.includes('workflow.quality-gate'));
    assert.ok(quality.requiredAssets.includes('runtime.preset'));
    assert.ok(quality.optionalAssets.includes('workflow.quality-gate-platforms'));
    const checksums = fs.readFileSync(path.join(first.output, 'SHA256SUMS'), 'utf8');
    assert.match(checksums, new RegExp(sha256(first.manifestBytes)));
    assert.match(checksums, /fetch-a3-ci-github\.mjs/);
  });
});

// contract_id: contract.ci-selective-distribution.delivery
test('release generator binds every published byte to the exact source commit', async () => {
  await withFixture('a3-ci-github-distribution-release-binding-', (root) => {
    const sourcePath = 'workflows/quality/quality-gate.yml';
    const workingPath = path.join(committedSourceRoot, sourcePath);
    const committedBytes = fs.readFileSync(workingPath);
    try {
      fs.writeFileSync(workingPath, 'working-tree-only-change\n');
      const release = prepareRelease(root);
      assert.equal(release.manifest.files[sourcePath].sha256, sha256(committedBytes));
      assert.notEqual(release.manifest.files[sourcePath].sha256, sha256(Buffer.from('working-tree-only-change\n')));
    } finally {
      fs.writeFileSync(workingPath, committedBytes);
    }
  });
});

// contract_id: contract.ci-selective-distribution.delivery
test('release generator rejects invalid version source and output boundaries', async () => {
  await withFixture('a3-ci-github-distribution-release-guards-', (root) => {
    const generator = path.join(repositoryRoot, 'runtime/distribution/generate-distribution-release.ts');
    const execute = (args) => spawnSync(tsx, [generator, '--repository-root', committedSourceRoot, ...args], { encoding: 'utf8' });
    const invalidSha = execute([
      '--output-directory', path.join(root, 'invalid-sha'),
      '--source-revision', 'main',
      '--release-tag', releaseTag,
    ]);
    assert.equal(invalidSha.status, 2);
    assert.match(invalidSha.stderr, /distribution-release-source-revision-invalid/);
    const invalidTag = execute([
      '--output-directory', path.join(root, 'invalid-tag'),
      '--source-revision', sourceRevision,
      '--release-tag', 'latest',
    ]);
    assert.equal(invalidTag.status, 2);
    assert.match(invalidTag.stderr, /distribution-release-tag-invalid/);
    const versionMismatch = execute([
      '--output-directory', path.join(root, 'version-mismatch'),
      '--source-revision', sourceRevision,
      '--release-tag', 'v9.9.9',
    ]);
    assert.equal(versionMismatch.status, 2);
    assert.match(versionMismatch.stderr, /distribution-release-version-mismatch/);
    const headMismatch = execute([
      '--output-directory', path.join(root, 'head-mismatch'),
      '--source-revision', 'e'.repeat(40),
      '--release-tag', releaseTag,
    ]);
    assert.equal(headMismatch.status, 2);
    assert.match(headMismatch.stderr, /distribution-release-source-head-mismatch/);
    const existingOutput = path.join(root, 'existing');
    fs.mkdirSync(existingOutput);
    const outputConflict = execute([
      '--output-directory', existingOutput,
      '--source-revision', sourceRevision,
      '--release-tag', releaseTag,
    ]);
    assert.equal(outputConflict.status, 2);
    assert.match(outputConflict.stderr, /distribution-release-output-exists/);
  });
});

// contract_id: contract.ci-selective-distribution.delivery
test('manifest validation rejects malformed authority identity files and dependency references', async () => {
  await withFixture('a3-ci-github-distribution-manifest-validation-', (root) => {
    const { manifest } = prepareRelease(root);
    const cases = [
      [null, /distribution-manifest-invalid/],
      [{ ...manifest, schemaVersion: '2' }, /distribution-manifest-contract-unsupported/],
      [{ ...manifest, repository: 'other/repository' }, /distribution-manifest-source-untrusted/],
      [{ ...manifest, sourceRevision: 'main' }, /distribution-manifest-source-revision-invalid/],
      [{ ...manifest, releaseTag: 'latest' }, /distribution-manifest-release-tag-invalid/],
      [{ ...manifest, assets: null }, /distribution-manifest-shape-invalid/],
    ];
    for (const [candidate, diagnostic] of cases) {
      assert.throws(() => validateDistributionManifest(candidate), diagnostic);
    }
    const duplicate = structuredClone(manifest);
    duplicate.assets.push(structuredClone(duplicate.assets[0]));
    assert.throws(() => validateDistributionManifest(duplicate), /distribution-manifest-asset-invalid/);
    const invalidFile = structuredClone(manifest);
    const sourcePath = invalidFile.assets[0].files[0].sourcePath;
    invalidFile.files[sourcePath].sha256 = 'invalid';
    assert.throws(() => validateDistributionManifest(invalidFile), /distribution-manifest-file-invalid/);
    const unknownDependency = structuredClone(manifest);
    unknownDependency.assets[0].dependencies.push('unknown');
    assert.throws(() => validateDistributionManifest(unknownDependency), /distribution-dependency-unknown/);
    const unknownPresetAsset = structuredClone(manifest);
    unknownPresetAsset.presets[0].requiredAssets.push('unknown');
    assert.throws(() => validateDistributionManifest(unknownPresetAsset), /distribution-preset-asset-unknown/);
  });
});

// contract_id: contract.ci-selective-distribution.delivery
test('remote manifest loading confines the Release URL and release tag mapping', async () => {
  await withFixture('a3-ci-github-distribution-remote-manifest-', async (root) => {
    const release = prepareRelease(root);
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (url) => {
        const parsed = new URL(String(url));
        if (parsed.hostname === 'github.com') {
          return {
            ok: false,
            status: 302,
            headers: { get: () => 'https://release-assets.githubusercontent.com/signed-manifest' },
          };
        }
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          arrayBuffer: async () => release.manifestBytes,
        };
      };
      const validUrl = `https://github.com/a3-suite/a3-ci-github/releases/download/${releaseTag}/a3-ci-github-distribution-manifest.json`;
      const loaded = await loadDistributionManifest({ manifestUrl: validUrl });
      assert.equal(loaded.manifest.sourceRevision, sourceRevision);
      await assert.rejects(
        loadDistributionManifest({
          manifestUrl: 'https://github.com/a3-suite/a3-ci-github/releases/download/v9.9.9/a3-ci-github-distribution-manifest.json',
        }),
        /distribution-manifest-release-url-mismatch/,
      );
      await assert.rejects(
        loadDistributionManifest({ manifestUrl: 'https://example.invalid/manifest.json' }),
        /distribution-manifest-url-untrusted/,
      );
      await assert.rejects(
        loadDistributionManifest({ manifestPath: release.manifestPath, manifestUrl: validUrl }),
        /distribution-manifest-source-exclusive/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// contract_id: contract.ci-selective-distribution.selection
test('preset selection closes dependencies while direct asset selection reports missing dependencies', async () => {
  await withFixture('a3-ci-github-distribution-selection-', (root) => {
    const { manifest } = prepareRelease(root);
    const presetAssets = resolveDistributionSelection(manifest, ['quality-gate'], []);
    assert.ok(presetAssets.some((asset) => asset.id === 'registry.ci-github'));
    assert.ok(presetAssets.some((asset) => asset.id === 'workflow.quality-gate'));
    assert.throws(() => resolveDistributionSelection(manifest, [], []), /distribution-selection-required/);
    assert.throws(() => resolveDistributionSelection(manifest, ['unknown'], []), /distribution-preset-unknown/);
    assert.throws(() => resolveDistributionSelection(manifest, [], ['unknown']), /distribution-asset-unknown/);
    assert.throws(
      () => resolveDistributionSelection(manifest, [], ['runtime.preset']),
      /distribution-dependency-missing:runtime\.preset:registry\.ci-github/,
    );
    const cyclic = structuredClone(manifest);
    cyclic.assets.find((asset) => asset.id === 'registry.ci-github').dependencies.push('runtime.preset');
    assert.throws(() => resolveDistributionSelection(cyclic, ['quality-gate'], []), /distribution-dependency-cycle/);
    const directAssets = resolveDistributionSelection(
      manifest,
      [],
      ['runtime.preset', 'registry.ci-github'],
    );
    assert.deepEqual(directAssets.map((asset) => asset.id), ['registry.ci-github', 'runtime.preset']);
  });
});

// contract_id: contract.ci-selective-distribution.delivery
// contract_id: contract.ci-selective-distribution.application
test('fetch, plan, apply and rollback preserve explicit consumer state transitions', async () => {
  await withFixture('a3-ci-github-distribution-lifecycle-', async (root) => {
      const release = prepareRelease(root);
      const projectRoot = path.join(root, 'consumer');
      fs.mkdirSync(projectRoot);
      const fetched = await fetchDistribution({
        projectRoot,
        manifest: release.manifest,
        manifestBytes: release.manifestBytes,
        requestedPresets: ['quality-gate'],
        requestedAssets: [],
        sourceRoot: repositoryRoot,
      });
      assert.equal(fetched.action, 'fetched');
      assert.ok(fs.existsSync(path.join(fetched.distributionRoot, 'runtime/preset/run-validate-ci-preset.mjs')));
      assert.equal(verifyFetchedDistribution({ projectRoot, sourceRevision }).status, 'verified');
      const plan = planDistributionApplication({
        projectRoot,
        sourceRevision,
        requestedPresets: ['quality-gate'],
        requestedAssets: [],
      });
      assert.deepEqual(plan.actions.map((entry) => entry.action), ['create']);
      const applied = applyDistributionPlan({
        projectRoot,
        planPath: plan.planPath,
        approvalDigest: plan.planDigest,
      });
      const workflow = path.join(projectRoot, '.github/workflows/quality-gate.yml');
      assert.equal(applied.status, 'applied');
      assert.ok(fs.existsSync(workflow));
      assert.ok(applied.nextSteps.includes('preflight'));
      const rolledBack = rollbackDistributionTransaction({ projectRoot, transactionId: applied.transactionId });
      assert.equal(rolledBack.status, 'rolled-back');
      assert.equal(rolledBack.rollbackStatus, 'restored');
      assert.equal(fs.existsSync(workflow), false);
  });
});

// contract_id: contract.ci-selective-distribution.application
test('plan rejects unmanaged destination drift and apply rejects changed plan inputs', async () => {
  await withFixture('a3-ci-github-distribution-conflict-', async (root) => {
      const release = prepareRelease(root);
      const projectRoot = path.join(root, 'consumer');
      fs.mkdirSync(path.join(projectRoot, '.github/workflows'), { recursive: true });
      await fetchDistribution({
        projectRoot,
        manifest: release.manifest,
        manifestBytes: release.manifestBytes,
        requestedPresets: ['quality-gate'],
        requestedAssets: [],
        sourceRoot: repositoryRoot,
      });
      const workflow = path.join(projectRoot, '.github/workflows/quality-gate.yml');
      fs.writeFileSync(workflow, 'name: consumer-owned\n');
      const conflict = planDistributionApplication({
        projectRoot,
        sourceRevision,
        requestedPresets: ['quality-gate'],
        requestedAssets: [],
      });
      assert.deepEqual(conflict.actions.map((entry) => entry.action), ['conflict']);
      assert.throws(
        () => applyDistributionPlan({ projectRoot, planPath: conflict.planPath, approvalDigest: conflict.planDigest }),
        /distribution-plan-has-conflicts/,
      );
      fs.rmSync(workflow);
      const plan = planDistributionApplication({
        projectRoot,
        sourceRevision,
        requestedPresets: ['quality-gate'],
        requestedAssets: [],
      });
      fs.writeFileSync(workflow, 'name: changed-after-plan\n');
      assert.throws(
        () => applyDistributionPlan({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest }),
        /distribution-plan-input-changed/,
      );
  });
});

// contract_id: contract.ci-selective-distribution.delivery
test('fetch rejects source bytes that do not match the release manifest', async () => {
  await withFixture('a3-ci-github-distribution-integrity-', async (root) => {
    const release = prepareRelease(root);
    const projectRoot = path.join(root, 'consumer');
    fs.mkdirSync(projectRoot);
    const manifest = structuredClone(release.manifest);
    manifest.files['workflows/quality/quality-gate.yml'].sha256 = '0'.repeat(64);
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(
      fetchDistribution({
        projectRoot,
        manifest,
        manifestBytes,
        requestedPresets: [],
        requestedAssets: ['workflow.quality-gate'],
        sourceRoot: repositoryRoot,
      }),
      /distribution-file-integrity-mismatch/,
    );
    assert.equal(fs.existsSync(path.join(projectRoot, '.a3-skills/ci-github/distributions', sourceRevision)), false);
  });
});

// contract_id: contract.ci-selective-distribution.delivery
test('fetch rejects a project-local state path redirected through a symlink', async () => {
  await withFixture('a3-ci-github-distribution-symlink-state-', async (root) => {
    const release = prepareRelease(root);
    const projectRoot = path.join(root, 'consumer');
    const externalRoot = path.join(root, 'external');
    fs.mkdirSync(path.join(projectRoot, '.a3-skills/ci-github'), { recursive: true });
    fs.mkdirSync(externalRoot);
    fs.symlinkSync(externalRoot, path.join(projectRoot, '.a3-skills/ci-github/distributions'));
    await assert.rejects(
      fetchDistribution({
        projectRoot,
        manifest: release.manifest,
        manifestBytes: release.manifestBytes,
        requestedPresets: ['quality-gate'],
        requestedAssets: [],
        sourceRoot: repositoryRoot,
      }),
      /distribution-local-root-outside-project/,
    );
    assert.deepEqual(fs.readdirSync(externalRoot), []);
  });
});

// contract_id: contract.ci-selective-distribution.delivery
test('local verification rejects distribution bytes changed after fetch', async () => {
  await withFixture('a3-ci-github-distribution-local-integrity-', async (root) => {
    const release = prepareRelease(root);
    const projectRoot = path.join(root, 'consumer');
    fs.mkdirSync(projectRoot);
    const fetched = await fetchDistribution({
      projectRoot,
      manifest: release.manifest,
      manifestBytes: release.manifestBytes,
      requestedPresets: [],
      requestedAssets: ['workflow.quality-gate'],
      sourceRoot: repositoryRoot,
    });
    fs.writeFileSync(path.join(fetched.distributionRoot, 'workflows/quality/quality-gate.yml'), 'tampered\n');
    assert.throws(
      () => verifyFetchedDistribution({ projectRoot, sourceRevision }),
      /distribution-local-file-integrity-mismatch/,
    );
  });
});

// contract_id: contract.ci-selective-distribution.selection
// contract_id: contract.ci-selective-distribution.application
test('direct workflow asset fetch cannot bypass preset closure during apply planning', async () => {
  await withFixture('a3-ci-github-distribution-direct-workflow-', async (root) => {
    const release = prepareRelease(root);
    const projectRoot = path.join(root, 'consumer');
    fs.mkdirSync(projectRoot);
    await fetchDistribution({
      projectRoot,
      manifest: release.manifest,
      manifestBytes: release.manifestBytes,
      requestedPresets: [],
      requestedAssets: ['workflow.quality-gate'],
      sourceRoot: repositoryRoot,
    });
    assert.throws(
      () => planDistributionApplication({
        projectRoot,
        sourceRevision,
        requestedPresets: [],
        requestedAssets: ['workflow.quality-gate'],
      }),
      /distribution-copy-requires-matching-preset:workflow\.quality-gate/,
    );
    await fetchDistribution({
      projectRoot,
      manifest: release.manifest,
      manifestBytes: release.manifestBytes,
      requestedPresets: ['release-request'],
      requestedAssets: [],
      sourceRoot: repositoryRoot,
    });
    assert.throws(
      () => planDistributionApplication({
        projectRoot,
        sourceRevision,
        requestedPresets: ['release-request'],
        requestedAssets: ['workflow.quality-gate'],
      }),
      /distribution-copy-requires-matching-preset:workflow\.quality-gate/,
    );
    await fetchDistribution({
      projectRoot,
      manifest: release.manifest,
      manifestBytes: release.manifestBytes,
      requestedPresets: ['quality-gate'],
      requestedAssets: ['workflow.quality-gate-platforms'],
      sourceRoot: repositoryRoot,
    });
    const optionalPlan = planDistributionApplication({
      projectRoot,
      sourceRevision,
      requestedPresets: ['quality-gate'],
      requestedAssets: ['workflow.quality-gate-platforms'],
    });
    assert.ok(optionalPlan.actions.some((entry) => entry.assetId === 'workflow.quality-gate-platforms'));
  });
});

// contract_id: contract.ci-selective-distribution.application
test('apply rechecks destination ancestry immediately before writing', async () => {
  await withFixture('a3-ci-github-distribution-apply-symlink-', async (root) => {
    const release = prepareRelease(root);
    const projectRoot = path.join(root, 'consumer');
    const externalRoot = path.join(root, 'external');
    fs.mkdirSync(projectRoot);
    fs.mkdirSync(externalRoot);
    await fetchDistribution({
      projectRoot,
      manifest: release.manifest,
      manifestBytes: release.manifestBytes,
      requestedPresets: ['quality-gate'],
      requestedAssets: [],
      sourceRoot: repositoryRoot,
    });
    const plan = planDistributionApplication({
      projectRoot,
      sourceRevision,
      requestedPresets: ['quality-gate'],
      requestedAssets: [],
    });
    assert.throws(
      () => applyDistributionPlan({
        projectRoot,
        planPath: plan.planPath,
        approvalDigest: plan.planDigest,
        beforeWrite: () => fs.symlinkSync(externalRoot, path.join(projectRoot, '.github')),
      }),
      /distribution-destination-outside-root/,
    );
    assert.deepEqual(fs.readdirSync(externalRoot), []);
  });
});

// contract_id: contract.ci-selective-distribution.application
test('partial apply failure restores files changed earlier in the transaction', async () => {
  await withFixture('a3-ci-github-distribution-partial-', async (root) => {
    const release = prepareRelease(root);
    const projectRoot = path.join(root, 'consumer');
    fs.mkdirSync(projectRoot);
    await fetchDistribution({
      projectRoot,
      manifest: release.manifest,
      manifestBytes: release.manifestBytes,
      requestedPresets: ['release-publication'],
      requestedAssets: [],
      sourceRoot: repositoryRoot,
    });
    const plan = planDistributionApplication({
      projectRoot,
      sourceRevision,
      requestedPresets: ['release-publication'],
      requestedAssets: [],
    });
    assert.ok(plan.actions.length > 1);
    const changedLater = plan.actions[1].destination;
    const changedPath = path.join(projectRoot, changedLater);
    assert.throws(
      () => applyDistributionPlan({
        projectRoot,
        planPath: plan.planPath,
        approvalDigest: plan.planDigest,
        beforeWrite: ({ index }) => {
          if (index !== 1) return;
          fs.mkdirSync(path.dirname(changedPath), { recursive: true });
          fs.writeFileSync(changedPath, 'changed-after-plan\n');
        },
      }),
      /distribution-plan-input-changed/,
    );
    assert.equal(fs.existsSync(path.join(projectRoot, plan.actions[0].destination)), false);
    assert.equal(fs.readFileSync(changedPath, 'utf8'), 'changed-after-plan\n');
    const transactionsRoot = path.join(projectRoot, '.a3-skills/ci-github/transactions');
    const transactionDirectories = fs.readdirSync(transactionsRoot);
    assert.equal(transactionDirectories.length, 1);
    const transaction = JSON.parse(fs.readFileSync(
      path.join(transactionsRoot, transactionDirectories[0], 'transaction.json'),
      'utf8',
    ));
    assert.equal(transaction.status, 'rolled-back');
    assert.equal(transaction.actions[0].state, 'restored');
    assert.equal(transaction.actions[1].state, 'not-applied');
    transaction.status = 'rollback-required';
    const transactionPath = path.join(transactionsRoot, transactionDirectories[0], 'transaction.json');
    fs.writeFileSync(transactionPath, `${JSON.stringify(transaction, null, 2)}\n`);
    assert.equal(rollbackDistributionTransaction({
      projectRoot,
      transactionId: transaction.transactionId,
    }).status, 'rolled-back');
    assert.equal(fs.readFileSync(changedPath, 'utf8'), 'changed-after-plan\n');
  });
});

// contract_id: contract.ci-selective-distribution.application
test('application rejects invalid ownership approval and concurrent mutation locks', async () => {
  await withFixture('a3-ci-github-distribution-application-guards-', async (root) => {
    const release = prepareRelease(root);
    const projectRoot = path.join(root, 'consumer');
    fs.mkdirSync(projectRoot);
    await fetchDistribution({
      projectRoot,
      manifest: release.manifest,
      manifestBytes: release.manifestBytes,
      requestedPresets: ['quality-gate'],
      requestedAssets: [],
      sourceRoot: repositoryRoot,
    });
    const assetLockPath = path.join(projectRoot, '.ci/ci-assets.lock.json');
    fs.mkdirSync(path.dirname(assetLockPath), { recursive: true });
    fs.writeFileSync(assetLockPath, '{"schemaVersion":"1","kind":"invalid","assets":[]}\n');
    assert.throws(
      () => planDistributionApplication({
        projectRoot,
        sourceRevision,
        requestedPresets: ['quality-gate'],
        requestedAssets: [],
      }),
      /distribution-prior-asset-lock-invalid/,
    );
    fs.rmSync(assetLockPath);
    const plan = planDistributionApplication({
      projectRoot,
      sourceRevision,
      requestedPresets: ['quality-gate'],
      requestedAssets: [],
    });
    assert.throws(
      () => applyDistributionPlan({ projectRoot, planPath: plan.planPath, approvalDigest: '0'.repeat(64) }),
      /distribution-plan-approval-invalid/,
    );
    fs.mkdirSync(path.dirname(assetLockPath), { recursive: true });
    fs.writeFileSync(assetLockPath, '{}\n');
    assert.throws(
      () => applyDistributionPlan({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest }),
      /distribution-plan-ownership-changed/,
    );
    fs.rmSync(assetLockPath);
    const mutationLock = path.join(projectRoot, '.a3-skills/ci-github/apply.lock');
    const transactionsPath = path.join(projectRoot, '.a3-skills/ci-github/transactions');
    const externalTransactions = path.join(root, 'external-transactions');
    fs.rmSync(transactionsPath, { recursive: true, force: true });
    fs.mkdirSync(externalTransactions);
    fs.symlinkSync(externalTransactions, transactionsPath);
    assert.throws(
      () => applyDistributionPlan({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest }),
      /distribution-transaction-root-outside-project/,
    );
    assert.equal(fs.existsSync(mutationLock), false);
    fs.rmSync(transactionsPath);
    fs.writeFileSync(mutationLock, 'occupied\n');
    assert.throws(
      () => applyDistributionPlan({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest }),
      /distribution-apply-locked/,
    );
    fs.rmSync(mutationLock);
    const applied = applyDistributionPlan({
      projectRoot,
      planPath: plan.planPath,
      approvalDigest: plan.planDigest,
    });
    fs.writeFileSync(mutationLock, 'occupied\n');
    assert.throws(
      () => rollbackDistributionTransaction({ projectRoot, transactionId: applied.transactionId }),
      /distribution-apply-locked/,
    );
    fs.rmSync(mutationLock);
  });
});

// contract_id: contract.ci-selective-distribution.application
test('rollback validates every backup identity before changing consumer files', async () => {
  await withFixture('a3-ci-github-distribution-backup-integrity-', (root) => {
    const projectRoot = path.join(root, 'consumer');
    const transactionId = `1-${'a'.repeat(12)}`;
    const transactionRoot = path.join(projectRoot, '.a3-skills/ci-github/transactions', transactionId);
    const first = { destination: '.github/workflows/first.yml', before: 'first-before\n', after: 'first-after\n' };
    const second = { destination: '.github/workflows/second.yml', before: 'second-before\n', after: 'second-after\n' };
    for (const entry of [first, second]) {
      const destination = path.join(projectRoot, entry.destination);
      const backup = path.join(transactionRoot, 'before', entry.destination);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.writeFileSync(destination, entry.after);
      fs.writeFileSync(backup, entry.before);
    }
    fs.writeFileSync(path.join(transactionRoot, 'before', second.destination), 'tampered\n');
    fs.writeFileSync(path.join(transactionRoot, 'transaction.json'), `${JSON.stringify({
      schemaVersion: '1',
      kind: 'a3-ci-github-distribution-transaction',
      transactionId,
      planDigest: 'b'.repeat(64),
      sourceRevision,
      status: 'applied',
      actions: [first, second].map((entry) => ({
        destination: entry.destination,
        beforeSha256: sha256(Buffer.from(entry.before)),
        afterSha256: sha256(Buffer.from(entry.after)),
        state: 'applied',
      })),
    }, null, 2)}\n`);
    assert.throws(
      () => rollbackDistributionTransaction({ projectRoot, transactionId }),
      /distribution-backup-integrity-mismatch/,
    );
    assert.equal(fs.readFileSync(path.join(projectRoot, first.destination), 'utf8'), first.after);
    fs.writeFileSync(path.join(transactionRoot, 'before', second.destination), second.before);
    const transactionPath = path.join(transactionRoot, 'transaction.json');
    const interrupted = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
    interrupted.status = 'applying';
    interrupted.actions[0].state = 'restored';
    fs.writeFileSync(path.join(projectRoot, first.destination), first.before);
    fs.writeFileSync(transactionPath, `${JSON.stringify(interrupted, null, 2)}\n`);
    assert.equal(
      rollbackDistributionTransaction({ projectRoot, transactionId }).status,
      'rolled-back',
    );
    assert.equal(fs.readFileSync(path.join(projectRoot, second.destination), 'utf8'), second.before);
  });
});

// contract_id: contract.ci-selective-distribution.application
test('rollback refuses to overwrite consumer changes made after apply', async () => {
  await withFixture('a3-ci-github-distribution-rollback-conflict-', async (root) => {
    const release = prepareRelease(root);
    const projectRoot = path.join(root, 'consumer');
    fs.mkdirSync(projectRoot);
    await fetchDistribution({
      projectRoot,
      manifest: release.manifest,
      manifestBytes: release.manifestBytes,
      requestedPresets: ['quality-gate'],
      requestedAssets: [],
      sourceRoot: repositoryRoot,
    });
    const plan = planDistributionApplication({
      projectRoot,
      sourceRevision,
      requestedPresets: ['quality-gate'],
      requestedAssets: [],
    });
    const applied = applyDistributionPlan({
      projectRoot,
      planPath: plan.planPath,
      approvalDigest: plan.planDigest,
    });
    const workflow = path.join(projectRoot, '.github/workflows/quality-gate.yml');
    fs.writeFileSync(workflow, 'name: edited-after-apply\n');
    assert.throws(
      () => rollbackDistributionTransaction({ projectRoot, transactionId: applied.transactionId }),
      /distribution-rollback-destination-changed/,
    );
    assert.equal(fs.readFileSync(workflow, 'utf8'), 'name: edited-after-apply\n');
  });
});

// contract_id: contract.ci-selective-distribution.delivery
// contract_id: contract.ci-selective-distribution.application
test('standalone public CLI executes the local fetch plan and approved apply boundary', async () => {
  await withFixture('a3-ci-github-distribution-cli-', (root) => {
    const release = prepareRelease(root);
    const projectRoot = path.join(root, 'consumer');
    fs.mkdirSync(projectRoot);
    const cli = path.join(repositoryRoot, 'runtime/distribution/fetch-a3-ci-github.mjs');
    const fetchResult = spawnSync(process.execPath, [
      cli, 'fetch',
      '--manifest', release.manifestPath,
      '--source-root', repositoryRoot,
      '--preset', 'quality-gate',
      '--repo-root', projectRoot,
    ], { encoding: 'utf8' });
    assert.equal(fetchResult.status, 0, fetchResult.stderr);
    const fetched = JSON.parse(fetchResult.stdout);
    assert.equal(fetched.sourceRevision, sourceRevision);
    const verifyResult = spawnSync(process.execPath, [
      cli, 'verify',
      '--source-revision', sourceRevision,
      '--repo-root', projectRoot,
    ], { encoding: 'utf8' });
    assert.equal(verifyResult.status, 0, verifyResult.stderr);
    assert.equal(JSON.parse(verifyResult.stdout).status, 'verified');
    const planResult = spawnSync(process.execPath, [
      cli, 'plan',
      '--source-revision', sourceRevision,
      '--preset', 'quality-gate',
      '--repo-root', projectRoot,
    ], { encoding: 'utf8' });
    assert.equal(planResult.status, 0, planResult.stderr);
    const plan = JSON.parse(planResult.stdout);
    const applyResult = spawnSync(process.execPath, [
      cli, 'apply',
      '--plan', plan.planPath,
      '--approve', plan.planDigest,
      '--repo-root', projectRoot,
    ], { encoding: 'utf8' });
    assert.equal(applyResult.status, 0, applyResult.stderr);
    assert.equal(JSON.parse(applyResult.stdout).status, 'applied');
  });
});

// contract_id: contract.ci-selective-distribution.delivery
test('same revision merges separately fetched verified asset groups without replacing prior files', async () => {
  await withFixture('a3-ci-github-distribution-merge-', async (root) => {
      const release = prepareRelease(root);
      const projectRoot = path.join(root, 'consumer');
      fs.mkdirSync(projectRoot);
      await fetchDistribution({
        projectRoot,
        manifest: release.manifest,
        manifestBytes: release.manifestBytes,
        requestedPresets: [],
        requestedAssets: ['registry.ci-github'],
        sourceRoot: repositoryRoot,
      });
      const merged = await fetchDistribution({
        projectRoot,
        manifest: release.manifest,
        manifestBytes: release.manifestBytes,
        requestedPresets: [],
        requestedAssets: ['lint.github-actions'],
        sourceRoot: repositoryRoot,
      });
      assert.equal(merged.action, 'merged');
      assert.deepEqual(merged.selectedAssets, ['lint.github-actions', 'registry.ci-github']);
      assert.ok(fs.existsSync(path.join(merged.distributionRoot, 'skills/ci-github/references/ci-distribution-assets.reference.yml')));
      assert.ok(fs.existsSync(path.join(merged.distributionRoot, 'lint-rules/a3-lint/ci_github_workflow_name_matches_file.lua')));
  });
});
