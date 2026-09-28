import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  loadReleaseRequestFixtureModel,
  snapshotTree,
  writeReleaseRequestFixture,
} from '../runtime/preset/tests/support/release-request-fixture.mjs';

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testRoot, '..');
const runtimeRoot = path.resolve(
  process.env.CI_GITHUB_PREFLIGHT_RUNTIME_ROOT ?? path.join(repositoryRoot, 'runtime/preset'),
);
const tsxPath = path.join(runtimeRoot, 'node_modules/.bin/tsx');
const model = loadReleaseRequestFixtureModel({ repositoryRoot, runtimeRoot });
const execute = (command, args, options = {}) => spawnSync(command, args, {
  encoding: 'utf8',
  ...options,
});

const withFixture = (prefix, callback) => {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false);
  }
};

const prepareBootstrapRuntime = (consumerRoot) => {
  const target = path.join(consumerRoot, '.a3-skills/ci-github/runtime');
  mkdirSync(target, { recursive: true });
  for (const filename of ['package.json', 'package-lock.json']) {
    cpSync(path.join(repositoryRoot, 'runtime/preset', filename), path.join(target, filename));
  }
  const lock = JSON.parse(readFileSync(path.join(target, 'package-lock.json'), 'utf8'));
  for (const relative of Object.keys(lock.packages).filter((entry) => entry.startsWith('node_modules/'))) {
    const source = path.join(runtimeRoot, relative);
    if (!existsSync(source)) continue;
    const destination = path.join(target, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true });
  }
  mkdirSync(path.join(target, 'node_modules/.bin'), { recursive: true });
  cpSync(
    path.join(runtimeRoot, 'node_modules/.bin/tsx'),
    path.join(target, 'node_modules/.bin/tsx'),
    { verbatimSymlinks: true },
  );
};

// flow_id: consumer-preset-assurance-cli
// contract_id: contract.ci-preset-assurance.verification
// contract_id: contract.ci-preset-assurance.asset-lock
test('public preset CLIs generate an asset lock and validate read-only without consumer drift', () => {
  withFixture('a3-ci-github-preset-e2e-', (consumerRoot) => {
    const skillCollectionRoot = path.join(consumerRoot, 'skills');
    mkdirSync(skillCollectionRoot);
    writeReleaseRequestFixture({ repositoryRoot, root: consumerRoot, model });

    const lockResult = execute(tsxPath, [
      path.join(repositoryRoot, 'runtime/preset/generate-ci-asset-lock.ts'),
      '--repo-root', consumerRoot,
      '--skill-collection-root', skillCollectionRoot,
      '--source-revision', 'c'.repeat(40),
    ], {
      env: { ...process.env, CI_GITHUB_PREFLIGHT_RUNTIME_ROOT: runtimeRoot },
    });
    assert.equal(lockResult.status, 0, lockResult.stderr);
    const lock = JSON.parse(lockResult.stdout);
    assert.equal(lock.sourceRevision, 'c'.repeat(40));
    assert.ok(lock.assets.length > 0);

    prepareBootstrapRuntime(consumerRoot);
    const before = snapshotTree(consumerRoot);
    const validationResult = execute(process.execPath, [
      path.join(repositoryRoot, 'runtime/preset/run-validate-ci-preset.mjs'),
      '--audit-mode', 'read-only',
      '--repo-root', consumerRoot,
      '--skill-collection-root', skillCollectionRoot,
      '--preset', 'release-request',
    ]);
    assert.equal(validationResult.status, 0, validationResult.stderr);
    const report = JSON.parse(validationResult.stdout);
    assert.equal(report.status, 'success');
    assert.deepEqual(report.inspectedPresets, ['release-request']);
    assert.ok(report.evidence.length > 0);
    assert.equal(report.semanticReviewRequired, true);
    assert.deepEqual(snapshotTree(consumerRoot), before);
  });
});

// flow_id: consumer-adapter-materialization-cli
// contract_id: contract.ci-preset-materialization.application
test('public materializer CLI copies reuses and protects consumer adapter files', () => {
  withFixture('a3-ci-github-materializer-e2e-', (fixtureRoot) => {
    const skillCollectionRoot = path.join(fixtureRoot, 'skills');
    const descriptorRoot = path.join(skillCollectionRoot, 'rust/assets');
    const targetRoot = path.join(fixtureRoot, 'consumer');
    mkdirSync(descriptorRoot, { recursive: true });
    writeFileSync(path.join(skillCollectionRoot, 'rust/SKILL.md'), '# rust fixture\n');
    writeFileSync(path.join(descriptorRoot, 'test-bundle.json'), JSON.stringify({
      schemaVersion: '1',
      kind: 'ci-adapter-bundle',
      id: 'test-bundle',
      contract: 'quality-scripts',
      provider: 'provider-neutral',
      executionBoundary: 'read-only',
      sourceCheckout: 'fixed-source',
      copyable: true,
      languageProfiles: ['rust'],
      owner: 'rust',
      assets: [{ id: 'repository-helper', destination: '.ci/runtime/vitest-test-summary.ts' }],
      commands: [{ command: 'echo', args: ['test'] }],
      preparation: [{ command: 'echo', args: ['prepare'] }],
      toolchain: {
        versionEnv: 'CI_TOOLCHAIN_VERSION',
        verify: { command: 'echo', args: ['verify'] },
      },
      projectSettings: { requiredFiles: [], requiredScripts: [] },
    }));
    const command = [
      path.join(repositoryRoot, 'runtime/adapter/materialize-adapter-bundle.ts'),
      '--source-root', skillCollectionRoot,
      '--inventory', 'tests/fixtures/materializer-inventory.json',
      '--bundle', 'test-bundle',
      '--target-root', targetRoot,
    ];
    const options = { env: { ...process.env, CI_FIXED_RUNTIME_ROOT: runtimeRoot } };

    const first = execute(tsxPath, command, options);
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(JSON.parse(first.stdout).files.map((entry) => entry.action), ['copied', 'copied']);
    assert.equal(
      readFileSync(path.join(targetRoot, '.ci/runtime/vitest-test-summary.ts'), 'utf8'),
      readFileSync(path.join(repositoryRoot, 'runtime/adapter/vitest-test-summary.ts'), 'utf8'),
    );
    const descriptor = path.join(targetRoot, '.ci/adapters/test-bundle.json');
    assert.equal(JSON.parse(readFileSync(descriptor, 'utf8')).id, 'test-bundle');
    const materialized = snapshotTree(targetRoot);

    const second = execute(tsxPath, command, options);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(JSON.parse(second.stdout).files.map((entry) => entry.action), ['reused', 'reused']);
    assert.deepEqual(snapshotTree(targetRoot), materialized);

    writeFileSync(descriptor, '{"id":"conflict"}\n');
    const beforeConflict = snapshotTree(targetRoot);
    const conflict = execute(tsxPath, command, options);
    assert.equal(conflict.status, 1);
    assert.match(conflict.stderr, /adapter-materializer-destination-conflict/);
    assert.deepEqual(snapshotTree(targetRoot), beforeConflict);
  });
});
