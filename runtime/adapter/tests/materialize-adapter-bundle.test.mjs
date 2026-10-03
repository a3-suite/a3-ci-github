import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';

import { materializeAdapterBundle } from '../materialize-adapter-bundle.ts';
import { fileURLToPath } from 'node:url';
import { snapshotTree } from '../../preset/tests/support/release-request-fixture.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const withFixture = (callback) => {
  mkdirSync(path.join(repository, 'tmp'), { recursive: true });
  const fixture = mkdtempSync(path.join(repository, 'tmp/a3-ci-github-materializer-'));
  try {
    callback(fixture);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    assert.equal(existsSync(fixture), false);
  }
};

test('materializer separates repository-owned assets from external skill resources', () => withFixture((fixture) => {
  const runtimeRoot = path.join(fixture, 'runtime');
  const yamlRoot = path.join(runtimeRoot, 'node_modules', 'yaml');
  mkdirSync(yamlRoot, { recursive: true });
  writeFileSync(path.join(yamlRoot, 'package.json'), JSON.stringify({
    name: 'yaml',
    version: '0.0.0-test',
    main: 'index.cjs',
  }));
  writeFileSync(path.join(yamlRoot, 'index.cjs'), [
    "exports.parseDocument = (input) => ({",
    '  errors: [],',
    '  toJS: () => JSON.parse(input),',
    '});',
    '',
  ].join('\n'));

  const skillCollectionRoot = path.join(fixture, 'skills');
  const rustSkillRoot = path.join(skillCollectionRoot, 'rust');
  mkdirSync(path.join(rustSkillRoot, 'assets'), { recursive: true });
  writeFileSync(path.join(rustSkillRoot, 'SKILL.md'), '# rust fixture\n');
  writeFileSync(path.join(rustSkillRoot, 'assets', 'test-bundle.json'), JSON.stringify({
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
    commands: [{ id: 'test', command: 'echo', args: ['test'] }],
    preparation: [{ id: 'prepare', command: 'echo', args: ['prepare'] }],
    toolchain: { versionEnv: 'CI_TOOLCHAIN_VERSION', verify: { id: 'verify', command: 'echo', args: ['verify'] } },
    projectSettings: { requiredFiles: [], requiredScripts: [] },
  }));

  const targetRoot = path.join(fixture, 'project');
  const previousRuntimeRoot = process.env.CI_FIXED_RUNTIME_ROOT;
  process.env.CI_FIXED_RUNTIME_ROOT = runtimeRoot;
  try {
    assert.throws(() => materializeAdapterBundle({
      inventoryPath: 'tests/fixtures/materializer-inventory.json',
      bundleId: 'test-bundle', targetRoot,
    }), /adapter-materializer-source-root-required/);
    assert.equal(existsSync(targetRoot), false);
    const report = materializeAdapterBundle({
      sourceRoot: skillCollectionRoot,
      inventoryPath: 'tests/fixtures/materializer-inventory.json',
      bundleId: 'test-bundle',
      targetRoot,
    });

    assert.equal(report.schema, 'ci.adapter-materializer.v1');
    assert.deepEqual(report.files.map((file) => file.source), [
      'runtime/adapter/vitest-test-summary.ts',
      'rust/assets/test-bundle.json',
    ]);
    assert.match(
      readFileSync(path.join(targetRoot, '.ci/runtime/vitest-test-summary.ts'), 'utf8'),
      /Vitest/,
    );
    const targetDescriptor = path.join(targetRoot, '.ci/adapters/test-bundle.json');
    const targetAsset = path.join(targetRoot, '.ci/runtime/vitest-test-summary.ts');
    const materialized = JSON.parse(readFileSync(targetDescriptor, 'utf8'));
    assert.equal(materialized.id, 'test-bundle');
    assert.deepEqual(materialized.preparation.map((command) => command.id), ['prepare']);
    assert.deepEqual(materialized.commands.map((command) => command.id), ['test']);
    assert.equal(materialized.toolchain.verify.id, 'verify');

    const descriptorSource = path.join(rustSkillRoot, 'assets/test-bundle.json');
    const descriptorSourceContent = readFileSync(descriptorSource, 'utf8');
    for (const outputPath of [targetDescriptor, targetAsset, descriptorSource]) {
      rmSync(targetRoot, { recursive: true, force: true });
      assert.throws(
        () => materializeAdapterBundle({
          sourceRoot: skillCollectionRoot,
          inventoryPath: 'tests/fixtures/materializer-inventory.json',
          bundleId: 'test-bundle',
          targetRoot,
          outputPath,
        }),
        /adapter-materializer-output-conflict/,
      );
      assert.equal(existsSync(targetRoot), false);
      assert.equal(existsSync(targetDescriptor), false);
      assert.equal(existsSync(targetAsset), false);
      assert.equal(readFileSync(descriptorSource, 'utf8'), descriptorSourceContent);
    }

    materializeAdapterBundle({
      sourceRoot: skillCollectionRoot,
      inventoryPath: 'tests/fixtures/materializer-inventory.json',
      bundleId: 'test-bundle',
      targetRoot,
    });
    writeFileSync(targetDescriptor, '{"id":"conflicting-descriptor"}\n');
    assert.throws(
      () => materializeAdapterBundle({
        sourceRoot: skillCollectionRoot,
        inventoryPath: 'tests/fixtures/materializer-inventory.json',
        bundleId: 'test-bundle',
        targetRoot,
      }),
      /adapter-materializer-destination-conflict/,
    );

    rmSync(targetRoot, { recursive: true, force: true });
    writeFileSync(descriptorSource, JSON.stringify({
      ...JSON.parse(descriptorSourceContent),
      projectSettings: { requiredFiles: [], requiredScripts: ['lint', 'shared-check'] },
    }));
    mkdirSync(targetRoot, { recursive: true });
    writeFileSync(path.join(targetRoot, 'package.json'), JSON.stringify({
      scripts: { lint: '', 'shared-check': 'node skills/ci/source.ts' },
    }));
    assert.throws(
      () => materializeAdapterBundle({
        sourceRoot: skillCollectionRoot,
        inventoryPath: 'tests/fixtures/materializer-inventory.json',
        bundleId: 'test-bundle',
        targetRoot,
      }),
      /adapter-materializer-project-script-invalid:lint/,
    );
    writeFileSync(path.join(targetRoot, 'package.json'), JSON.stringify({
      scripts: { lint: 'true', 'shared-check': 'node skills/ci/source.ts' },
    }));
    assert.throws(
      () => materializeAdapterBundle({
        sourceRoot: skillCollectionRoot,
        inventoryPath: 'tests/fixtures/materializer-inventory.json',
        bundleId: 'test-bundle',
        targetRoot,
      }),
      /adapter-materializer-project-script-source-reference:shared-check/,
    );
  } finally {
    if (previousRuntimeRoot === undefined) delete process.env.CI_FIXED_RUNTIME_ROOT;
    else process.env.CI_FIXED_RUNTIME_ROOT = previousRuntimeRoot;
  }
}));

const withCustomBundle = (callback) => withFixture((fixture) => {
  const skills = path.join(fixture, 'skills');
  const owner = path.join(skills, 'collection/rust');
  const targetRoot = path.join(fixture, 'project');
  const descriptorPath = path.join(owner, 'assets/test-bundle.json');
  const inventoryPath = path.join(fixture, 'inventory.json');
  mkdirSync(path.dirname(descriptorPath), { recursive: true });
  mkdirSync(targetRoot);
  writeFileSync(path.join(owner, 'SKILL.md'), '# fixture\n');
  const descriptor = {
    schemaVersion: '1', kind: 'ci-adapter-bundle', id: 'test-bundle', contract: 'quality-scripts',
    provider: 'provider-neutral', executionBoundary: 'read-only', sourceCheckout: 'fixed-source',
    copyable: true, languageProfiles: ['rust'], owner: 'rust',
    assets: [{ id: 'helper', destination: '.ci/runtime/helper.ts' }],
    commands: [{ id: 'test', command: 'node' }],
    preparation: [{ id: 'prepare', command: 'node' }],
    toolchain: { versionEnv: 'CI_TOOLCHAIN_VERSION', verify: { id: 'verify', command: 'node' } },
    projectSettings: { requiredFiles: [], requiredScripts: [] },
  };
  const inventory = {
    assets: [{ id: 'helper', copyable: true, entrypoints: ['runtime/adapter/vitest-test-summary.ts'] }],
    adapterBundles: [{ id: descriptor.id, source: { skill: 'rust', path: 'assets/test-bundle.json' }, targetDescriptor: '.ci/adapters/test-bundle.json' }],
  };
  const options = { sourceRoot: skills, inventoryPath, bundleId: descriptor.id, targetRoot };
  const previous = process.env.CI_FIXED_RUNTIME_ROOT;
  process.env.CI_FIXED_RUNTIME_ROOT = path.join(repository, 'runtime/preset');
  try {
    callback({ descriptor, inventory, descriptorPath, inventoryPath, options, targetRoot });
  } finally {
    if (previous === undefined) delete process.env.CI_FIXED_RUNTIME_ROOT;
    else process.env.CI_FIXED_RUNTIME_ROOT = previous;
  }
});

// evidence_role: contract
// test_level: integration
// integration_id: adapter-materialization-rejection
// contract_id: contract.ci-preset-materialization.application
test('materializer rejects invalid custom bundle inputs before copying consumer assets', () => withCustomBundle((fixture) => {
  // Arrange
  const cases = [
    [(value) => { value.schemaVersion = '2'; }, /descriptor-invalid/],
    [(value) => { value.executionBoundary = 'write'; }, /descriptor-contract-invalid/],
    [(value) => { value.languageProfiles = []; }, /language-profiles-invalid/],
    [(value) => { value.owner = ''; }, /descriptor-owner-invalid/],
    [(value) => { value.assets = null; }, /assets-invalid/],
    [(value) => { value.assets[0].source = 'skills/source'; }, /source-field-forbidden/],
    [(value) => { value.assets[0].destination = 'outside.ts'; }, /destination-invalid/],
    [(value) => { value.assets[0].destination = '.ci/../../outside.ts'; }, /path-outside-root/],
    [(value) => { value.assets[0].id = 'missing'; }, /source-asset-unavailable/],
    [(value) => { value.assets.push({ ...value.assets[0] }); }, /destination-duplicate/],
    [(value) => { value.id = 'different'; }, /descriptor-id-mismatch/],
    [(value) => { value.commands = []; }, /commands-invalid/],
    [(value) => { value.commands = [null]; }, /command-invalid/],
    [(value) => { value.commands[0].args = []; }, /args-invalid/],
    [(value) => { value.commands[0].command = 'node\n'; }, /command-invalid/],
    [(value) => { value.commands[0].id = 'prepare'; }, /command-duplicate/],
    [(value) => { value.commands[0].args = ['skills/ci/check.ts']; }, /command-source-reference/],
    [(value) => { value.toolchain = null; }, /toolchain-invalid/],
    [(value) => { value.toolchain.verify.args = ['']; }, /toolchain-args-invalid/],
    [(value) => { value.projectSettings = null; }, /project-settings-invalid/],
    [(value) => { value.projectSettings.requiredFiles = ['missing.toml']; }, /project-file-missing/],
  ];
  writeFileSync(fixture.inventoryPath, JSON.stringify(fixture.inventory));
  for (const [mutate, diagnostic] of cases) {
    const changed = structuredClone(fixture.descriptor);
    mutate(changed);
    writeFileSync(fixture.descriptorPath, JSON.stringify(changed));
    const before = snapshotTree(fixture.targetRoot);
    // Act
    const execute = () => materializeAdapterBundle(fixture.options);
    // Assert
    assert.throws(execute, diagnostic);
    assert.deepEqual(snapshotTree(fixture.targetRoot), before);
  }
  // Arrange
  writeFileSync(fixture.descriptorPath, JSON.stringify(fixture.descriptor));
  const inventoryCases = [
    [(value) => { value.adapterBundles = null; }, /inventory-invalid/],
    [(value) => { value.adapterBundles = [null]; }, /bundle-not-found/],
    [(value) => { value.adapterBundles[0].delivery = 'copy'; }, /delivery-invalid/],
    [(value) => { value.adapterBundles[0].source = null; }, /bundle-source-invalid/],
    [(value) => { value.adapterBundles[0].source.skill = ''; }, /bundle-source-invalid/],
    [(value) => { value.adapterBundles[0].source.skill = 'missing'; }, /skill-not-found/],
    [(value) => { value.adapterBundles[0].targetDescriptor = 'outside.json'; }, /target-descriptor-invalid/],
    [(value) => { value.assets = null; }, /inventory-invalid/],
    [(value) => { value.assets = [null]; }, /source-asset-unavailable/],
    [(value) => { value.assets.push({ ...value.assets[0] }); }, /source-asset-duplicate/],
    [(value) => { value.assets[0].copyable = false; }, /source-asset-unavailable/],
    [(value) => { value.assets[0].entrypoints = []; }, /source-asset-unavailable/],
    [(value) => { value.assets[0].source = {}; }, /source-invalid/],
    [(value) => { value.assets[0].source = 'runtime/adapter/missing.ts'; }, /source-missing/],
  ];
  for (const [mutate, diagnostic] of inventoryCases) {
    const changed = structuredClone(fixture.inventory);
    mutate(changed);
    writeFileSync(fixture.inventoryPath, JSON.stringify(changed));
    const before = snapshotTree(fixture.targetRoot);
    // Act
    const execute = () => materializeAdapterBundle(fixture.options);
    // Assert
    assert.throws(execute, diagnostic);
    assert.deepEqual(snapshotTree(fixture.targetRoot), before);
  }
  // Arrange
  writeFileSync(fixture.inventoryPath, JSON.stringify(fixture.inventory));
  // Act
  const result = materializeAdapterBundle(fixture.options);
  // Assert
  assert.deepEqual(result.files.map((entry) => entry.action), ['copied', 'copied']);
  assert.equal(readFileSync(path.join(fixture.targetRoot, '.ci/adapters/test-bundle.json'), 'utf8'), JSON.stringify(fixture.descriptor));
}));

// evidence_role: contract
// test_level: integration
// integration_id: adapter-materialization-rejection
// contract_id: contract.ci-preset-materialization.application
test('materializer validates delegated project scripts without copying shared implementations', () => withCustomBundle((fixture) => {
  // Arrange
  fixture.descriptor.projectSettings.requiredScripts = ['lint'];
  writeFileSync(fixture.descriptorPath, JSON.stringify(fixture.descriptor));
  writeFileSync(fixture.inventoryPath, JSON.stringify(fixture.inventory));
  const packagePath = path.join(fixture.targetRoot, 'package.json');
  const cases = [
    [undefined, /project-file-missing:package.json/],
    ['{', /project-file-invalid:package.json/],
    ['null', /project-scripts-invalid/],
    [JSON.stringify({ scripts: {} }), /project-scripts-missing:lint/],
    [JSON.stringify({ scripts: { lint: 1 } }), /project-script-invalid:lint/],
    [JSON.stringify({ scripts: { lint: 'npm run child', child: 'pnpm run lint' } }), /project-script-cycle:lint/],
    [JSON.stringify({ scripts: { lint: 'npm run child', child: 'node skills/shared.ts' } }), /project-script-source-reference:child/],
  ];
  for (const [content, diagnostic] of cases) {
    if (content !== undefined) writeFileSync(packagePath, content);
    const before = snapshotTree(fixture.targetRoot);
    // Act
    const execute = () => materializeAdapterBundle(fixture.options);
    // Assert
    assert.throws(execute, diagnostic);
    assert.deepEqual(snapshotTree(fixture.targetRoot), before);
  }
  // Arrange
  const scripts = { scripts: { lint: 'npm run child', child: 'node --version' } };
  writeFileSync(packagePath, JSON.stringify(scripts));
  // Act
  materializeAdapterBundle(fixture.options);
  // Assert
  assert.deepEqual(JSON.parse(readFileSync(packagePath, 'utf8')), scripts);
  assert.equal(existsSync(path.join(fixture.targetRoot, 'skills')), false);
}));
