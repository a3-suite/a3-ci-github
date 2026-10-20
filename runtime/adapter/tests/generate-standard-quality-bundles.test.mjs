import fs from 'node:fs';
import path from 'node:path';
import { test, describe, expect } from 'vitest';
import { STANDARD_QUALITY_BUNDLES } from '../standard-quality-bundles.generated.ts';
import { generateStandardQualityBundles } from '../generate-standard-quality-bundles.mjs';
import { root, inventory, outputPath, fixture } from "./generate-standard-quality-bundles.fixtures.mjs";

describe('adapter-bundle-materialization-contract', () => {
  // integration_id: adapter-bundle-materialization-contract
  test('standard bundle regeneration uses repository source bytes and detects generated drift', (t) => {
    // Arrange
    const provider = fixture(t);
    const original = fs.readFileSync(path.join(root, outputPath));
    const output = path.join(provider, outputPath);
    const options = { repositoryRoot: provider };
    // Act
    generateStandardQualityBundles(options);
    // Assert
    expect(fs.readFileSync(output)).toStrictEqual(original);
    generateStandardQualityBundles({ ...options, check: true });
    fs.appendFileSync(path.join(provider, STANDARD_QUALITY_BUNDLES[0].sourcePath), '\n');
    expect(() => generateStandardQualityBundles({ ...options, check: true })).toThrow(/generated-content-drift/);
    expect(fs.readFileSync(output)).toStrictEqual(original);
    generateStandardQualityBundles(options);
    generateStandardQualityBundles({ ...options, check: true });
    expect(fs.readFileSync(output)).not.toStrictEqual(original);
    fs.appendFileSync(output, '\n');
    expect(() => generateStandardQualityBundles({ ...options, check: true })).toThrow(/generated-content-drift/);
    expect(fs.readFileSync(path.join(root, outputPath))).toStrictEqual(original);
  });

  // integration_id: adapter-bundle-materialization-contract
  test('standard bundle regeneration rejects external sources and owner metadata drift', (t) => {
    // Arrange
    const provider = fixture(t);
    const source = path.join(provider, STANDARD_QUALITY_BUNDLES[0].sourcePath);
    const original = fs.readFileSync(source, 'utf8');
    // Act / Assert
    for (const changed of [
      original.replace('owner: ci-github', 'owner: rust'),
      original.replace('provider: provider-neutral', 'provider: unsupported'),
      original.replace('executionBoundary: read-only', 'executionBoundary: trusted-control'),
      original.replace('copyable: true', 'copyable: false'),
    ]) {
      fs.writeFileSync(source, changed);
      expect(() => generateStandardQualityBundles({ repositoryRoot: provider })).toThrow(/source-contract-mismatch/);
    }
    fs.unlinkSync(source);
    fs.symlinkSync(path.join(root, STANDARD_QUALITY_BUNDLES[0].sourcePath), source);
    expect(() => generateStandardQualityBundles({ repositoryRoot: provider })).toThrow(/source-outside-repository/);
    const originalInventory = fs.readFileSync(path.join(provider, inventory), 'utf8');
    fs.writeFileSync(path.join(provider, inventory), originalInventory.replace('source: {path: runtime/adapter/bundles/rust-quality.yml}', 'source: {skill: rust, path: assets/ci/adapter-bundles/rust-quality.yml}'));
    expect(() => generateStandardQualityBundles({ repositoryRoot: provider })).toThrow(/source-contract-mismatch/);
  });
});
