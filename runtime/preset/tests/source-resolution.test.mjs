import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('canonical source resolution separates repository assets from external skills', async () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'a3-ci-github-preset-source-'));
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

    const rustSkillRoot = path.join(fixture, 'skills', 'languages', 'rust');
    const descriptor = path.join(rustSkillRoot, 'assets', 'rust-quality.yml');
    mkdirSync(path.dirname(descriptor), { recursive: true });
    writeFileSync(path.join(rustSkillRoot, 'SKILL.md'), '# rust fixture\n');
    writeFileSync(descriptor, 'kind: fixture\n');

    assert.equal(
      canonicalSourcePath(
        { path: 'workflows/quality/quality-gate.yml' },
        repositoryRoot,
        path.join(fixture, 'skills'),
      ),
      path.join(repositoryRoot, 'workflows/quality/quality-gate.yml'),
    );
    assert.equal(
      canonicalSourcePath(
        { skill: 'rust', path: 'assets/rust-quality.yml' },
        repositoryRoot,
        path.join(fixture, 'skills'),
      ),
      descriptor,
    );
    assert.equal(
      canonicalSourcePath(
        { skill: 'rust', path: 'assets/rust-quality.yml' },
        repositoryRoot,
      ),
      '',
    );
  } finally {
    if (previousRuntimeRoot === undefined) delete process.env.CI_GITHUB_PREFLIGHT_RUNTIME_ROOT;
    else process.env.CI_GITHUB_PREFLIGHT_RUNTIME_ROOT = previousRuntimeRoot;
    rmSync(fixture, { recursive: true, force: true });
    assert.equal(existsSync(fixture), false);
  }
});
