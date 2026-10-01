import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { STANDARD_QUALITY_BUNDLES } from '../standard-quality-bundles.generated.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

// integration_id: adapter-bundle-materialization-contract
test('standard bundle regeneration rejects a different repository with matching descriptors', () => {
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  const fixture = fs.mkdtempSync(path.join(root, 'tmp/quality-owner-identity-'));
  const git = (...args) => {
    const result = spawnSync('git', ['-C', fixture, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
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
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /standard-quality-source-repository-mismatch/);
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});
