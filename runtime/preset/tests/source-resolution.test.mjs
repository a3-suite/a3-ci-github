import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, describe, expect } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe("preset-source-resolution", () => {
  // evidence_role: supplemental
  // test_level: integration
  // integration_id: preset-source-resolution
  // Nested skill collections and an absent owner root supplement the preset's consumer flows.
  test('canonical source resolution separates repository assets from external skills', async () => {
    // Arrange
    const temporaryRoot = path.join(repositoryRoot, 'tests/tmp');
    mkdirSync(temporaryRoot, { recursive: true });
    const fixture = mkdtempSync(path.join(temporaryRoot, 'preset-source-'));
    const previousRuntimeRoot = process.env.CI_GITHUB_PREFLIGHT_RUNTIME_ROOT;
    try {
      const runtimeRoot = path.join(fixture, 'runtime');
      const yamlRoot = path.join(runtimeRoot, 'node_modules', 'yaml');
      mkdirSync(yamlRoot, { recursive: true });
      writeFileSync(path.join(runtimeRoot, 'package.json'), JSON.stringify({ private: true }));
      writeFileSync(path.join(yamlRoot, 'package.json'), JSON.stringify({
        name: 'yaml',
        version: '0.0.0-test',
        main: 'index.cjs',
      }));
      writeFileSync(path.join(yamlRoot, 'index.cjs'), [
        'exports.parse = (input) => JSON.parse(input);',
        "exports.parseDocument = (input) => ({ errors: [], toJS: () => JSON.parse(input) });",
        '',
      ].join('\n'));
      process.env.CI_GITHUB_PREFLIGHT_RUNTIME_ROOT = runtimeRoot;

      const moduleUrl = pathToFileURL(path.join(repositoryRoot, 'runtime/preset/validate-ci-preset.ts'));
      moduleUrl.searchParams.set('test', path.basename(fixture));
      const { canonicalSourcePath } = await import(moduleUrl.href);
      const { adapterBundleAssets } = await import('../ci-preset-assets.ts');

      const rustSkillRoot = path.join(fixture, 'skills', 'languages', 'rust');
      const descriptor = path.join(rustSkillRoot, 'assets', 'rust-quality.yml');
      mkdirSync(path.dirname(descriptor), { recursive: true });
      writeFileSync(path.join(rustSkillRoot, 'SKILL.md'), '# rust fixture\n');
      const expectedAssets = [{ id: 'helper', destination: '.ci/helper.ts' }];
      writeFileSync(descriptor, JSON.stringify({ assets: [...expectedAssets, null, { id: 'invalid' }] }));

      // Act
      const repositorySource = canonicalSourcePath(
        { path: 'workflows/quality/quality-gate.yml' },
        repositoryRoot,
        path.join(fixture, 'skills'),
      );
      const externalSource = canonicalSourcePath(
        { skill: 'rust', path: 'assets/rust-quality.yml' },
        repositoryRoot,
        path.join(fixture, 'skills'),
      );
      const absentOwner = canonicalSourcePath(
        { skill: 'rust', path: 'assets/rust-quality.yml' },
        repositoryRoot,
      );
      const report = { missingSettings: [], mismatches: [] };
      const assets = adapterBundleAssets({
        source: { skill: 'rust', path: 'assets/rust-quality.yml' },
      }, path.join(fixture, 'skills'), report);
      // Assert
      expect(repositorySource).toBe(path.join(repositoryRoot, 'workflows/quality/quality-gate.yml'));
      expect(externalSource).toBe(descriptor);
      expect(absentOwner).toBe('');
      expect(assets).toStrictEqual(expectedAssets);
      expect(report.mismatches).toStrictEqual([]);
    } finally {
      if (previousRuntimeRoot === undefined) delete process.env.CI_GITHUB_PREFLIGHT_RUNTIME_ROOT;
      else process.env.CI_GITHUB_PREFLIGHT_RUNTIME_ROOT = previousRuntimeRoot;
      rmSync(fixture, { recursive: true, force: true });
      expect(existsSync(fixture)).toBe(false);
    }
  });
});
