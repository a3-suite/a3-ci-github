import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, describe, expect } from 'vitest';
import { STANDARD_QUALITY_BUNDLES } from '../standard-quality-bundles.generated.ts';
import { generateStandardQualityBundles } from '../generate-standard-quality-bundles.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe("adapter-bundle-materialization-contract", () => {
  // integration_id: adapter-bundle-materialization-contract
  test('standard bundle regeneration uses fixed Git bytes and detects generated drift', () => {
    // Arrange
    fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
    const fixture = fs.mkdtempSync(path.join(root, 'tmp/quality-generation-'));
    const provider = path.join(fixture, 'provider');
    const owner = path.join(fixture, 'owner');
    const originalOutput = path.join(root, 'runtime/adapter/standard-quality-bundles.generated.ts');
    const before = fs.readFileSync(originalOutput);
    const git = (...args) => {
      const result = spawnSync('git', ['-C', owner, ...args], { encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    try {
      fs.mkdirSync(owner);
      git('init', '-q');
      git('config', 'user.name', 'Owner Source Test');
      git('config', 'user.email', 'owner-test@example.invalid');
      git('remote', 'add', 'origin', 'https://github.com/izumilufty/a3-prompts');
      for (const entry of STANDARD_QUALITY_BUNDLES) {
        const destination = path.join(owner, entry.sourcePath);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, entry.descriptor);
      }
      git('add', '--all');
      git('commit', '-qm', 'fixture');
      const revision = git('rev-parse', 'HEAD');
      // Working-tree edits must not replace the selected Git object's bytes.
      fs.writeFileSync(path.join(owner, STANDARD_QUALITY_BUNDLES[0].sourcePath), 'uncommitted invalid descriptor');
      const inventory = 'skills/ci-github/references/ci-script-assets.reference.yml';
      fs.mkdirSync(path.dirname(path.join(provider, inventory)), { recursive: true });
      fs.copyFileSync(path.join(root, inventory), path.join(provider, inventory));
      fs.mkdirSync(path.join(provider, 'runtime/adapter'), { recursive: true });
      const options = { sourceRoot: owner, revision, repositoryRoot: provider };
      // Act
      generateStandardQualityBundles(options);
      const output = path.join(provider, 'runtime/adapter/standard-quality-bundles.generated.ts');
      const generated = fs.readFileSync(output, 'utf8');
      const entries = JSON.parse(generated.slice(generated.indexOf('= ') + 2, generated.lastIndexOf(' as const;')));
      // Assert
      expect(entries).toStrictEqual(STANDARD_QUALITY_BUNDLES.map((entry) => ({ ...entry, sourceRevision: revision })));
      generateStandardQualityBundles({ ...options, check: true });
      expect(fs.readFileSync(output, 'utf8')).toBe(generated);
      fs.writeFileSync(output, `${generated}\n`);
      expect(() => generateStandardQualityBundles({ ...options, check: true })).toThrow(/standard-quality-generated-content-drift/);
      expect(fs.readFileSync(output, 'utf8')).toBe(`${generated}\n`);
      expect(fs.readFileSync(originalOutput)).toStrictEqual(before);
    } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
  });

  // integration_id: adapter-bundle-materialization-contract
  test('standard bundle regeneration rejects a different repository with matching descriptors', () => {
    fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
    const fixture = fs.mkdtempSync(path.join(root, 'tmp/quality-owner-identity-'));
    const git = (...args) => {
      const result = spawnSync('git', ['-C', fixture, ...args], { encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    try {
      git('init', '-q');
      git('config', 'user.name', 'Owner Source Test');
      git('config', 'user.email', 'owner-test@example.invalid');
      for (const entry of STANDARD_QUALITY_BUNDLES) {
        const destination = path.join(fixture, entry.sourcePath);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, entry.descriptor);
      }
      git('add', '--all');
      git('commit', '-qm', 'fixture');
      const revision = git('rev-parse', 'HEAD');
      git('remote', 'add', 'origin', 'https://github.com/example/unrelated.git');
      const result = spawnSync(process.execPath, [
        path.join(root, 'runtime/adapter/generate-standard-quality-bundles.mjs'),
        '--source-root', fixture, '--source-revision', revision, '--check',
      ], { encoding: 'utf8' });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/standard-quality-source-repository-mismatch/);
    } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
  });
});
