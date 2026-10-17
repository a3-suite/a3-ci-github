import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, describe, expect } from 'vitest';
import { STANDARD_QUALITY_BUNDLES } from '../standard-quality-bundles.generated.ts';
import { generateStandardQualityBundles } from '../generate-standard-quality-bundles.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const inventory = 'skills/ci-github/assets/registry/ci-script-assets.yml';
const outputPath = 'runtime/adapter/standard-quality-bundles.generated.ts';
const fixture = (t) => {
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  const provider = fs.mkdtempSync(path.join(root, 'tmp/quality-generation-'));
  t.onTestFinished(() => fs.rmSync(provider, { recursive: true, force: true }));
  for (const file of [inventory, outputPath, ...STANDARD_QUALITY_BUNDLES.map(entry => entry.sourcePath)]) {
    fs.mkdirSync(path.dirname(path.join(provider, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(provider, file));
  }
  return provider;
};

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

  // integration_id: adapter-bundle-materialization-contract
  test('standard bundle generator CLI needs no external checkout and rejects legacy source arguments', () => {
    // Arrange
    const generator = path.join(root, 'runtime/adapter/generate-standard-quality-bundles.mjs');
    // Act
    const checked = spawnSync(process.execPath, [generator, '--check'], { encoding: 'utf8', cwd: root });
    const rejected = spawnSync(process.execPath, [generator, '--source-root', '/unavailable', '--source-revision', 'a'.repeat(40)], { encoding: 'utf8', cwd: root });
    // Assert
    expect(checked.status, checked.stderr).toBe(0);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toMatch(/generation-arguments-invalid/);
  });
});
