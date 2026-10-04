import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { describe, test, expect } from 'vitest';

describe('GitHub Actions fixture import', () => {
  // Importing a fixture must not launch an Action in the parent CI test process.
  test('shared fixture import remains side-effect-free under GitHub Actions environment', () => {
    const root = path.resolve(__dirname, '..');
    const fixtureUrl = pathToFileURL(path.resolve(root, '../../runtime/release-publication/tests/fixtures.mjs')).href;
    const result = spawnSync(process.execPath, ['--import=tsx', '--input-type=module', '--eval', `await import(${JSON.stringify(fixtureUrl)});`], {
      cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: '', GH_TOKEN: '' },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
  });
});
