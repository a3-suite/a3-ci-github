import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
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
  const temporaryRoot = path.join(repositoryRoot, 'tests/tmp');
  mkdirSync(temporaryRoot, { recursive: true });
  const root = mkdtempSync(path.join(temporaryRoot, prefix));
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

const preparePresetFixture = (consumerRoot, includeExternalRoot) => {
  const skillCollectionRoot = path.join(consumerRoot, 'skills');
  if (includeExternalRoot) mkdirSync(skillCollectionRoot);
  writeReleaseRequestFixture({ repositoryRoot, root: consumerRoot, model });
  return includeExternalRoot ? ['--skill-collection-root', skillCollectionRoot] : [];
};

const generateAssetLock = (consumerRoot, skillArguments) => execute(tsxPath, [
  path.join(repositoryRoot, 'runtime/preset/generate-ci-asset-lock.ts'),
  '--repo-root', consumerRoot,
  ...skillArguments,
  '--source-revision', 'c'.repeat(40),
], { env: { ...process.env, CI_GITHUB_PREFLIGHT_RUNTIME_ROOT: runtimeRoot } });

// evidence_role: contract
// test_level: e2e
// flow_id: consumer-preset-asset-lock-cli
// contract_id: contract.ci-preset-assurance.asset-lock
test('public asset lock CLI records source revision and managed assets', () => {
  for (const includeExternalRoot of [false, true]) {
    withFixture('a3-ci-github-asset-lock-e2e-', (consumerRoot) => {
      // Arrange
      const skillArguments = preparePresetFixture(consumerRoot, includeExternalRoot);
      // Act
      const result = generateAssetLock(consumerRoot, skillArguments);
      // Assert
      assert.equal(result.status, 0, result.stderr);
      const lock = JSON.parse(result.stdout);
      assert.equal(lock.sourceRevision, 'c'.repeat(40));
      assert.ok(lock.assets.length > 0);
    });
  }
});

// evidence_role: contract
// test_level: e2e
// flow_id: consumer-preset-assurance-cli
// contract_id: contract.ci-preset-assurance.verification
test('public preset validation CLI preserves the consumer tree in read-only mode', () => {
  for (const includeExternalRoot of [false, true]) {
    withFixture('a3-ci-github-preset-e2e-', (consumerRoot) => {
      // Arrange
      const skillArguments = preparePresetFixture(consumerRoot, includeExternalRoot);
      const lockResult = generateAssetLock(consumerRoot, skillArguments);
      assert.equal(lockResult.status, 0, lockResult.stderr);
      prepareBootstrapRuntime(consumerRoot);
      const before = snapshotTree(consumerRoot);
      // Act
      const validationResult = execute(process.execPath, [
        path.join(repositoryRoot, 'runtime/preset/run-validate-ci-preset.mjs'),
        '--audit-mode', 'read-only',
        '--repo-root', consumerRoot,
        ...skillArguments,
        '--preset', 'release-request',
      ]);
      // Assert
      assert.equal(validationResult.status, 0, validationResult.stderr);
      const report = JSON.parse(validationResult.stdout);
      assert.equal(report.status, 'success');
      assert.deepEqual(report.inspectedPresets, ['release-request']);
      assert.ok(report.evidence.length > 0);
      assert.equal(report.semanticReviewRequired, true);
      assert.deepEqual(snapshotTree(consumerRoot), before);
    });
  }
});

// evidence_role: contract
// test_level: e2e
// flow_id: consumer-preset-assurance-cli
// contract_id: contract.ci-preset-assurance.verification
test('preset bootstrap reports cleanup failure without publishing a false success or hiding validation failure', () => {
  withFixture('a3-ci-github-preset-cleanup-', (consumerRoot) => {
    // Arrange
    const skillCollectionRoot = path.join(consumerRoot, 'skills');
    mkdirSync(skillCollectionRoot);
    writeReleaseRequestFixture({ repositoryRoot, root: consumerRoot, model });
    const lockResult = execute(tsxPath, [
      path.join(repositoryRoot, 'runtime/preset/generate-ci-asset-lock.ts'),
      '--repo-root', consumerRoot,
      '--skill-collection-root', skillCollectionRoot,
      '--source-revision', 'c'.repeat(40),
    ], { env: { ...process.env, CI_GITHUB_PREFLIGHT_RUNTIME_ROOT: runtimeRoot } });
    assert.equal(lockResult.status, 0, lockResult.stderr);
    prepareBootstrapRuntime(consumerRoot);

    const preload = path.join(consumerRoot, 'fail-cleanup.mjs');
    const cleanupTargetRecord = path.join(consumerRoot, 'cleanup-target');
    writeFileSync(preload, [
      "import fs from 'node:fs';",
      "const original = fs.rmSync.bind(fs);",
      "fs.rmSync = (target, options) => {",
      "  if (String(target).includes('a3-ci-github-')) {",
      "    fs.writeFileSync(process.env.CLEANUP_TARGET_RECORD, String(target));",
      "    throw new Error('injected cleanup failure');",
      "  }",
      "  return original(target, options);",
      "};",
      '',
    ].join('\n'));
    const command = [
      '--import', preload,
      path.join(repositoryRoot, 'runtime/preset/run-validate-ci-preset.mjs'),
      '--audit-mode', 'read-only',
      '--repo-root', consumerRoot,
      '--skill-collection-root', skillCollectionRoot,
      '--preset', 'release-request',
    ];
    const environment = { ...process.env, CLEANUP_TARGET_RECORD: cleanupTargetRecord };
    const cleanupLeakedState = () => {
      const target = readFileSync(cleanupTargetRecord, 'utf8');
      rmSync(target, { recursive: true, force: true });
      rmSync(cleanupTargetRecord, { force: true });
    };

    // Act
    const successfulValidation = execute(process.execPath, command, { env: environment });
    // Assert
    assert.equal(successfulValidation.status, 2);
    assert.equal(successfulValidation.stdout, '');
    assert.equal(JSON.parse(successfulValidation.stderr.trim()).reason, 'tool-state-cleanup-failed');
    cleanupLeakedState();

    // Arrange
    writeFileSync(
      path.join(consumerRoot, '.github/workflows/release-request-tag.yml'),
      'name: drifted\n',
    );
    // Act
    const failedValidation = execute(process.execPath, command, { env: environment });
    // Assert
    assert.equal(failedValidation.status, 1);
    assert.equal(JSON.parse(failedValidation.stdout).status, 'failed');
    assert.equal(JSON.parse(failedValidation.stderr.trim()).reason, 'tool-state-cleanup-failed');
    cleanupLeakedState();
  });
});

const prepareMaterializer = (fixtureRoot) => {
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

  return { command, targetRoot, options };
};

// evidence_role: contract
// test_level: e2e
// flow_id: consumer-adapter-materialization-cli
// contract_id: contract.ci-preset-materialization.application
test('public materializer CLI copies reuses and protects consumer adapter files', () => {
  withFixture('a3-ci-github-materializer-e2e-', (fixtureRoot) => {
    // Arrange
    const { command, targetRoot, options } = prepareMaterializer(fixtureRoot);

    // Act
    const first = execute(tsxPath, command, options);
    // Assert
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(JSON.parse(first.stdout).files.map((entry) => entry.action), ['copied', 'copied']);
    assert.equal(
      readFileSync(path.join(targetRoot, '.ci/runtime/vitest-test-summary.ts'), 'utf8'),
      readFileSync(path.join(repositoryRoot, 'runtime/adapter/vitest-test-summary.ts'), 'utf8'),
    );
    const descriptor = path.join(targetRoot, '.ci/adapters/test-bundle.json');
    assert.equal(JSON.parse(readFileSync(descriptor, 'utf8')).id, 'test-bundle');
    const materialized = snapshotTree(targetRoot);

    // Act
    const second = execute(tsxPath, command, options);
    // Assert
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(JSON.parse(second.stdout).files.map((entry) => entry.action), ['reused', 'reused']);
    assert.deepEqual(snapshotTree(targetRoot), materialized);

    // Arrange
    writeFileSync(descriptor, '{"id":"conflict"}\n');
    const beforeConflict = snapshotTree(targetRoot);
    // Act
    const conflict = execute(tsxPath, command, options);
    // Assert
    assert.equal(conflict.status, 1);
    assert.match(conflict.stderr, /adapter-materializer-destination-conflict/);
    assert.deepEqual(snapshotTree(targetRoot), beforeConflict);
  });
});

// evidence_role: contract
// test_level: e2e
// flow_id: consumer-adapter-materialization-cli
// contract_id: contract.ci-preset-materialization.application
test('public materializer CLI executes a symlinked entrypoint', () => {
  withFixture('a3-ci-github-materializer-symlink-', (fixtureRoot) => {
    // Arrange
    const { command, targetRoot, options } = prepareMaterializer(fixtureRoot);
    const entrypoint = path.join(fixtureRoot, 'materializer.ts');
    symlinkSync(command[0], entrypoint);
    // Act
    const result = execute(tsxPath, [entrypoint, ...command.slice(1)], options);
    // Assert
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.schema, 'ci.adapter-materializer.v1');
    assert.deepEqual(report.files.map((entry) => entry.action), ['copied', 'copied']);
    assert.equal(
      readFileSync(path.join(targetRoot, '.ci/runtime/vitest-test-summary.ts'), 'utf8'),
      readFileSync(path.join(repositoryRoot, 'runtime/adapter/vitest-test-summary.ts'), 'utf8'),
    );
    assert.equal(JSON.parse(readFileSync(path.join(targetRoot, '.ci/adapters/test-bundle.json'), 'utf8')).id, 'test-bundle');
  });
});
