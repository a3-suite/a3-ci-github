import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { materializeAdapterBundle } from '../materialize-adapter-bundle.ts';

const withFixture = (callback) => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'a3-ci-github-materializer-'));
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
  } finally {
    if (previousRuntimeRoot === undefined) delete process.env.CI_FIXED_RUNTIME_ROOT;
    else process.env.CI_FIXED_RUNTIME_ROOT = previousRuntimeRoot;
  }
}));
