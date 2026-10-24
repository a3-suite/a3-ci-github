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
import { test, describe, expect } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
    expect(existsSync(root)).toBe(false);
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
  '--release-tag', 'v0.9.0',
], { env: { ...process.env, CI_GITHUB_PREFLIGHT_RUNTIME_ROOT: runtimeRoot } });

describe('contract.repository-action-distribution.integrity', () => {
  describe('repository-maintenance-cli', () => {
    // evidence_role: contract
    // test_level: e2e
    // flow_id: repository-maintenance-cli
    // contract_id: contract.repository-action-distribution.integrity
    // contract_id: contract.repository-managed-source-integrity.integrity
    test('maintenance entrypoints retain safe failure context and primary exits when sinks fail', () => {
      withFixture('maintenance-diagnostics-', (fixture) => {
        writeFileSync(path.join(fixture, 'existing-state'), 'preserved\n');
        const before = snapshotTree(fixture);
        const protectedValue = 'private-maintenance-value-must-not-appear';
        const cases = [
          ['update-action-references.mjs', 'repository-managed-source-integrity', 'input-validation', 2, 'action-reference-arguments-invalid', ''],
          ['update-action-index.mjs', 'repository-action-distribution', 'input-validation', 1, 'action-catalog-arguments-invalid', ''],
          ['verify-action-packages.mjs', 'repository-action-distribution', 'action-inventory', 1, 'filesystem-eacces', `
            import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
            fs.readdirSync = () => { const error = new Error(${JSON.stringify(protectedValue)}); error.code = 'EACCES'; throw error; };
            syncBuiltinESMExports();`],
        ];
        for (const [file, subject, stage, exit, reason, fault] of cases) {
          const cli = path.join(repositoryRoot, 'runtime/repository', file);
          const driver = `${fault}\nprocess.argv = [process.execPath, ${JSON.stringify(cli)}];
            await import(${JSON.stringify(pathToFileURL(cli).href)});`;
          const result = execute(process.execPath, ['--input-type=module', '-e', driver], { cwd: fixture });
          expect(result.status, result.stderr).toBe(exit);
          const line = result.stderr.split('\n').find(value => value.startsWith('ci-failure-diagnostic:'));
          const evidence = JSON.parse(line?.slice('ci-failure-diagnostic:'.length) ?? '{}');
          expect(evidence.classification).toMatchObject({ subject, stage, reason });
          expect(evidence['execution-state']).toMatchObject({ outcome: 'failure', write: 'not-started' });
          expect(evidence['next-check'].stage).toBe(stage);
          expect(result.stdout + result.stderr).not.toContain(protectedValue);
          expect(result.stderr).not.toMatch(/\n\s*at /);
          const sinkDriver = `${fault}\nprocess.argv = [process.execPath, ${JSON.stringify(cli)}];
            process.stderr.write = () => { throw new Error('diagnostic-sink-failed'); };
            await import(${JSON.stringify(pathToFileURL(cli).href)});`;
          const sink = execute(process.execPath, ['--input-type=module', '-e', sinkDriver], { cwd: fixture });
          expect(sink.status).toBe(exit);
          expect(sink.stdout + sink.stderr).toBe('');
        }
        const alias = execute('bash', [path.join(repositoryRoot, 'runtime/repository/update-release-aliases.sh')], {
          cwd: fixture, env: { ...process.env, RELEASE_TAG: protectedValue, RELEASE_SHA: '', CI_RELEASE_VALIDATE_ONLY: 'true' },
        });
        expect(alias.status).toBe(1);
        expect(alias.stdout + alias.stderr).not.toContain(protectedValue);
        const line = alias.stderr.split('\n').find(value => value.startsWith('ci-failure-diagnostic:'));
        const evidence = JSON.parse(line?.slice('ci-failure-diagnostic:'.length) ?? '{}');
        expect(evidence.classification).toMatchObject({ subject: 'repository-action-distribution', stage: 'input-validation' });
        expect(evidence.comparison).toMatchObject({ field: 'RELEASE_TAG', expected: 'vX.Y.Z' });
        expect(evidence['execution-state']).toMatchObject({ exit: 1, lastConfirmed: 'not-started', write: 'not-started' });
        expect(snapshotTree(fixture)).toEqual(before);
      });
    });

    // evidence_role: contract
    // test_level: e2e
    // flow_id: repository-maintenance-cli
    // contract_id: contract.repository-action-distribution.integrity
    test('source verification retains child status and completed stage when group output fails', () => {
      const cli = path.join(repositoryRoot, 'runtime/repository/verify-action-packages.mjs');
      for (const [fault, observed] of [['error.status = 7;', 7], ["error.code = 'ENOENT';", 'filesystem-enoent']]) {
      const driver = `import childProcess from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module';
        childProcess.execFileSync = () => { const error = new Error('private-child-command-output'); ${fault} throw error; };
        syncBuiltinESMExports();
        process.stdout.write = () => { throw new Error('group-output-failed'); };
        process.argv = [process.execPath, ${JSON.stringify(cli)}];
        await import(${JSON.stringify(pathToFileURL(cli).href)});`;
      const result = execute(process.execPath, ['--input-type=module', '-e', driver], { cwd: repositoryRoot });
      expect(result.status).toBe(1);
      const line = result.stderr.split('\n').find(value => value.startsWith('ci-failure-diagnostic:'));
      const evidence = JSON.parse(line?.slice('ci-failure-diagnostic:'.length) ?? '{}');
      expect(evidence.classification).toMatchObject({ stage: 'typecheck', reason: 'action-source-verification-failed' });
      expect(evidence.comparison).toMatchObject({ expected: 'zero-exit', observed, completedSteps: 0 });
      expect(evidence.comparison.remainingSteps).toBeGreaterThan(0);
      expect(evidence['execution-state'].lastConfirmed).toBe('verification-plan');
      expect(result.stdout).toBe('');
      expect(result.stderr).not.toMatch(/private-child-command-output|group-output-failed/);
      }
    });

    // evidence_role: contract
    // test_level: e2e
    // flow_id: repository-maintenance-cli
    // contract_id: contract.repository-action-distribution.integrity
    test('catalog write failure retains known write state without changing existing README', () => {
      const readme = path.join(repositoryRoot, 'README.md');
      const before = readFileSync(readme);
      const cli = path.join(repositoryRoot, 'runtime/repository/update-action-index.mjs');
      const source = '# project\n\n## Action一覧\n\n| Action | 用途 | 概要 |\n| --- | --- | --- |\n\n';
      const driver = `import fs from 'node:fs/promises'; import { syncBuiltinESMExports } from 'node:module';
        const read = fs.readFile;
        fs.readFile = (file, ...args) => file === ${JSON.stringify(readme)} ? Promise.resolve(${JSON.stringify(source)}) : read(file, ...args);
        fs.writeFile = async () => { const error = new Error('private-write-failure'); error.code = 'EACCES'; throw error; };
        syncBuiltinESMExports(); process.argv = [process.execPath, ${JSON.stringify(cli)}, '--write'];
        await import(${JSON.stringify(pathToFileURL(cli).href)});`;
      const result = execute(process.execPath, ['--input-type=module', '-e', driver]);
      expect(result.status).toBe(1);
      const line = result.stderr.split('\n').find(value => value.startsWith('ci-failure-diagnostic:'));
      const evidence = JSON.parse(line?.slice('ci-failure-diagnostic:'.length) ?? '{}');
      expect(evidence.classification).toMatchObject({ stage: 'catalog-write', reason: 'filesystem-eacces' });
      expect(evidence['execution-state']).toMatchObject({ lastConfirmed: 'catalog-projection', write: 'catalog-write-may-be-partial' });
      expect(result.stderr).not.toContain('private-write-failure');
      expect(readFileSync(readme)).toEqual(before);
    });
  });
});

describe('contract.ci-selective-distribution.delivery', () => {
  describe('distribution-bootstrap-cli', () => {
    // evidence_role: contract
    // test_level: e2e
    // flow_id: distribution-bootstrap-cli
    // contract_id: contract.ci-selective-distribution.delivery
    test('distribution CLI retains exit 2 when its diagnostic sink fails', () => {
      withFixture('distribution-diagnostic-sink-', (consumerRoot) => {
        writeFileSync(path.join(consumerRoot, 'existing-state'), 'preserved\n');
        const before = snapshotTree(consumerRoot);
        const cli = path.join(repositoryRoot, 'runtime/distribution/fetch-a3-ci-github.mjs');
        const normal = execute(process.execPath, [cli, 'not-a-command'], { cwd: consumerRoot });
        expect(normal.status).toBe(2);
        expect(JSON.parse(normal.stderr).diagnostic).toBe('distribution-command-unknown');
        const driver = `process.argv = [process.execPath, ${JSON.stringify(cli)}, 'not-a-command'];
          process.stderr.write = () => { throw new Error('diagnostic sink failed'); };
          await import(${JSON.stringify(pathToFileURL(cli).href)});`;
        const failedSink = execute(process.execPath, ['--input-type=module', '-e', driver], { cwd: consumerRoot });
        expect(failedSink.status, failedSink.stderr).toBe(2);
        expect(failedSink.stdout).toBe('');
        expect(failedSink.stderr).toBe('');
        expect(snapshotTree(consumerRoot)).toEqual(before);
      });
    });
  });
});

describe("contract.ci-preset-assurance.asset-lock", () => {
  describe("consumer-preset-asset-lock-cli", () => {
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
          expect(result.status, result.stderr).toBe(0);
          const lock = JSON.parse(result.stdout);
          expect(lock.sourceRevision).toBe('c'.repeat(40));
          expect(lock.assets.length > 0).toBeTruthy();
        });
      }
    });
  });
});

describe("contract.ci-preset-assurance.verification", () => {
  describe("consumer-preset-assurance-cli", () => {
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
          expect(lockResult.status, lockResult.stderr).toBe(0);
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
          expect(validationResult.status, validationResult.stderr).toBe(0);
          const report = JSON.parse(validationResult.stdout);
          expect(report.status).toBe('success');
          expect(report.inspectedPresets).toStrictEqual(['release-request']);
          expect(report.evidence.length > 0).toBeTruthy();
          expect(report.semanticReviewRequired).toBe(true);
          expect(snapshotTree(consumerRoot)).toStrictEqual(before);
        });
      }
    });

    // evidence_role: contract
    // test_level: e2e
    // flow_id: consumer-preset-assurance-cli
    // contract_id: contract.ci-preset-assurance.verification
    test('public preset validation CLI retains the failing preset status when a managed workflow drifts', () => {
      withFixture('a3-ci-github-preset-drift-', (consumerRoot) => {
        // Arrange
        const skillArguments = preparePresetFixture(consumerRoot, false);
        const lockResult = generateAssetLock(consumerRoot, skillArguments);
        expect(lockResult.status, lockResult.stderr).toBe(0);
        prepareBootstrapRuntime(consumerRoot);
        const workflow = path.join(consumerRoot, '.github/workflows/release-request-tag.yml');
        writeFileSync(workflow, `${readFileSync(workflow, 'utf8')}# drift\n`);
        // Act
        const validationResult = execute(process.execPath, [
          path.join(repositoryRoot, 'runtime/preset/run-validate-ci-preset.mjs'),
          '--audit-mode', 'read-only',
          '--repo-root', consumerRoot,
          ...skillArguments,
          '--preset', 'release-request',
        ]);
        // Assert
        expect(validationResult.status, validationResult.stderr).toBe(1);
        const report = JSON.parse(validationResult.stdout);
        expect(report.status).not.toBe('success');
        const line = validationResult.stderr.split('\n').find((value) => value.startsWith('ci-failure-diagnostic:'));
        expect(JSON.parse(line?.slice('ci-failure-diagnostic:'.length) ?? '{}')).toMatchObject({
          classification: { subject: 'ci-preset-assurance', operation: 'preflight', stage: 'preset-validation', reason: 'preset-validation-failed' },
          comparison: { field: 'preset-status', expected: 'success', observed: report.status },
        });
      });
    });

    // evidence_role: contract
    // test_level: e2e
    // flow_id: consumer-preset-assurance-cli
    // contract_id: contract.ci-preset-assurance.asset-lock
    test('public asset lock CLI retains the failing preset findings without writing a lock', () => {
      withFixture('a3-ci-github-lock-drift-', (consumerRoot) => {
        // Arrange
        const skillArguments = preparePresetFixture(consumerRoot, false);
        const workflow = path.join(consumerRoot, '.github/workflows/release-request-tag.yml');
        writeFileSync(workflow, readFileSync(workflow, 'utf8').replace(/^on:/m, 'on-changed:'));
        // Act
        const lockResult = generateAssetLock(consumerRoot, skillArguments);
        // Assert
        expect(lockResult.status, lockResult.stderr).toBe(2);
        const line = lockResult.stderr.split('\n').find((value) => value.startsWith('ci-failure-diagnostic:'));
        const evidence = JSON.parse(line?.slice('ci-failure-diagnostic:'.length) ?? '{}');
        expect(evidence).toMatchObject({
          classification: { subject: 'ci-preset-assurance', operation: 'lock', stage: 'preset-validation' },
          context: { inputs: { sourceRevision: 'c'.repeat(40) } },
          comparison: { field: 'preset-status', expected: 'success', observed: 'failed' },
        });
        expect([...evidence.comparison.missingSettings, ...evidence.comparison.mismatches].some((entry) => String(entry).includes('release-request-tag.yml'))).toBe(true);
        expect(existsSync(path.join(consumerRoot, '.ci/ci-assets.lock.json'))).toBe(false);

        // Act
        const invalidRevision = execute(tsxPath, [
          path.join(repositoryRoot, 'runtime/preset/generate-ci-asset-lock.ts'),
          '--repo-root', consumerRoot, ...skillArguments, '--source-revision', '/private/secret-revision', '--release-tag', 'v0.9.0',
        ], { env: { ...process.env, CI_GITHUB_PREFLIGHT_RUNTIME_ROOT: runtimeRoot } });
        // Assert
        expect(invalidRevision.status).toBe(2);
        const invalidLine = invalidRevision.stderr.split('\n').find((value) => value.startsWith('ci-failure-diagnostic:'));
        expect(JSON.parse(invalidLine?.slice('ci-failure-diagnostic:'.length) ?? '{}')).toMatchObject({
          classification: { stage: 'source-revision-validation' },
          context: { inputs: { sourceRevision: 'invalid-format' } },
          comparison: { field: 'source-revision', expected: 'full-commit-sha', observed: 'invalid-format' },
        });
        expect(invalidLine).not.toContain('secret-revision');
      });
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
          '--release-tag', 'v0.9.0',
        ], { env: { ...process.env, CI_GITHUB_PREFLIGHT_RUNTIME_ROOT: runtimeRoot } });
        expect(lockResult.status, lockResult.stderr).toBe(0);
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
        expect(successfulValidation.status).toBe(2);
        expect(successfulValidation.stdout).toBe('');
        expect(JSON.parse(successfulValidation.stderr.trim()).reason).toBe('tool-state-cleanup-failed');
        cleanupLeakedState();

        // Arrange
        writeFileSync(
          path.join(consumerRoot, '.github/workflows/release-request-tag.yml'),
          'name: drifted\n',
        );
        // Act
        const failedValidation = execute(process.execPath, command, { env: environment });
        // Assert
        expect(failedValidation.status).toBe(1);
        expect(JSON.parse(failedValidation.stdout).status).toBe('failed');
        expect(JSON.parse(failedValidation.stderr.split('\n').find((line) => line.startsWith('{'))).reason).toBe('tool-state-cleanup-failed');
        cleanupLeakedState();
      });
    });
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
    assets: [{ id: 'repository-helper', destination: '.ci/runtime/cli-runtime.ts' }],
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

describe("contract.ci-preset-materialization.application", () => {
  describe("consumer-adapter-materialization-cli", () => {
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
        expect(first.status, first.stderr).toBe(0);
        expect(JSON.parse(first.stdout).files.map((entry) => entry.action)).toStrictEqual(['copied', 'copied']);
        expect(readFileSync(path.join(targetRoot, '.ci/runtime/cli-runtime.ts'), 'utf8')).toBe(readFileSync(path.join(repositoryRoot, 'runtime/adapter/cli-runtime.ts'), 'utf8'));
        const descriptor = path.join(targetRoot, '.ci/adapters/test-bundle.json');
        expect(JSON.parse(readFileSync(descriptor, 'utf8')).id).toBe('test-bundle');
        const materialized = snapshotTree(targetRoot);

        // Act
        const second = execute(tsxPath, command, options);
        // Assert
        expect(second.status, second.stderr).toBe(0);
        expect(JSON.parse(second.stdout).files.map((entry) => entry.action)).toStrictEqual(['reused', 'reused']);
        expect(snapshotTree(targetRoot)).toStrictEqual(materialized);

        // Arrange
        writeFileSync(descriptor, '{"id":"conflict"}\n');
        const beforeConflict = snapshotTree(targetRoot);
        // Act
        const conflict = execute(tsxPath, command, options);
        // Assert
        expect(conflict.status).toBe(1);
        expect(conflict.stderr).toMatch(/adapter-materializer-destination-conflict/);
        expect(snapshotTree(targetRoot)).toStrictEqual(beforeConflict);
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
        expect(result.status, result.stderr).toBe(0);
        const report = JSON.parse(result.stdout);
        expect(report.schema).toBe('ci.adapter-materializer.v2');
        expect(report.files.map((entry) => entry.action)).toStrictEqual(['copied', 'copied']);
        expect(readFileSync(path.join(targetRoot, '.ci/runtime/cli-runtime.ts'), 'utf8')).toBe(readFileSync(path.join(repositoryRoot, 'runtime/adapter/cli-runtime.ts'), 'utf8'));
        expect(JSON.parse(readFileSync(path.join(targetRoot, '.ci/adapters/test-bundle.json'), 'utf8')).id).toBe('test-bundle');
      });
    });
  });
});
