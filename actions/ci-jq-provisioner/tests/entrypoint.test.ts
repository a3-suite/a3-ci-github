import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

test('bundled Action rejects an invalid version as provisioning failure', () => {
  const actionRoot = process.cwd();
  const action = readFileSync(path.join(actionRoot, 'action.yml'), 'utf8');
  assert.match(action, /^  using: node24$/m);
  assert.match(action, /^  main: dist\/index\.js$/m);
  const result = spawnSync(process.execPath, [path.join(actionRoot, 'dist/index.js')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      'INPUT_JQ-VERSION': 'not-exact',
      RUNNER_OS: 'Linux',
      RUNNER_ARCH: 'X64',
      RUNNER_TEMP: path.resolve('tests/tmp'),
      GITHUB_PATH: path.resolve('tests/tmp/unused-github-path'),
      GITHUB_ACTIONS: 'true',
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /jq-provision-failed: invalid exact version/);
});
