import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

// Importing a fixture must not launch an Action in the parent CI test process.
test('shared fixture import remains side-effect-free under GitHub Actions environment', () => {
  const root = path.resolve(__dirname, '..');
  const fixtureUrl = pathToFileURL(path.resolve(root, '../../runtime/release-publication/tests/fixtures.mjs')).href;
  const result = spawnSync(process.execPath, ['--import=tsx', '--input-type=module', '--eval', `await import(${JSON.stringify(fixtureUrl)});`], {
    cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: '', GH_TOKEN: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
});
