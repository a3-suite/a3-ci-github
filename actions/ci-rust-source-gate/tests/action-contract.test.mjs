import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const action = readFileSync(path.join(root, 'action.yml'), 'utf8');
const script = path.resolve(root, '../../runtime/rust-release/ci-source-gate.sh');

const runBlock = () => {
  const match = action.match(/^      run: \|\n((?: {8}.*\n?)+)/m);
  assert.ok(match, 'action.yml must contain a composite run block');
  return match[1].replace(/^ {8}/gm, '');
};

// integration_id: ci-rust-source-gate-action-regression
test('action.yml maps the public source gate inputs to the shared script', () => {
  // Arrange
  const actionPath = path.join(root, 'action.yml');
  // Act
  const action = readFileSync(actionPath, 'utf8');
  // Assert
  assert.match(action, /^name: ci-rust-source-gate$/m);
  assert.match(action, /^  using: composite$/m);
  for (const input of ['language-profile', 'authority-path']) {
    assert.match(action, new RegExp(`^  ${input}:$`, 'm'));
  }
  assert.match(action, /runtime\/rust-release\/ci-source-gate\.sh/);
  assert.match(action, /^  verified:$/m);
  assert.match(action, /^    value: \$\{\{ steps\.verify\.outputs\.verified \}\}$/m);
  assert.match(action, /^        LANGUAGE_PROFILE: \$\{\{ inputs\.language-profile \}\}$/m);
  assert.match(action, /^        AUTHORITY_PATH: \$\{\{ inputs\.authority-path \}\}$/m);
  accessSync(script, constants.R_OK | constants.X_OK);
});

// contract_id: contract.ci-rust-source-gate.outputs
// integration_id: ci-rust-source-gate-action
test('composite source gate exposes verified only after script success', () => {
  // Arrange
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'a3-ci-github-rust-source-action-'));
  const actionPath = path.join(fixture, 'actions', 'ci-rust-source-gate');
  const fixtureScript = path.join(fixture, 'runtime', 'rust-release', 'ci-source-gate.sh');
  const output = path.join(fixture, 'github-output');
  try {
    mkdirSync(path.dirname(fixtureScript), { recursive: true });
    mkdirSync(actionPath, { recursive: true });
    writeFileSync(fixtureScript, '#!/usr/bin/env bash\nset -euo pipefail\ntest "$1" = rust\ntest "$2" = authority.json\n');
    chmodSync(fixtureScript, 0o755);
    writeFileSync(output, '');
    // Act
    const success = spawnSync('bash', ['-euo', 'pipefail', '-c', runBlock()], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_ACTION_PATH: actionPath,
        GITHUB_OUTPUT: output,
        LANGUAGE_PROFILE: 'rust',
        AUTHORITY_PATH: 'authority.json',
      },
    });
    // Assert
    assert.equal(success.status, 0, success.stderr);
    assert.equal(readFileSync(output, 'utf8'), 'verified=true\n');

    // Arrange
    writeFileSync(output, '');
    // Act
    const failure = spawnSync('bash', ['-euo', 'pipefail', '-c', runBlock()], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_ACTION_PATH: actionPath,
        GITHUB_OUTPUT: output,
        LANGUAGE_PROFILE: 'python',
        AUTHORITY_PATH: 'authority.json',
      },
    });
    // Assert
    assert.notEqual(failure.status, 0);
    assert.equal(readFileSync(output, 'utf8'), '');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
