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
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const action = readFileSync(path.join(root, 'action.yml'), 'utf8');
const scriptRoot = path.resolve(root, '../../runtime/rust-release');

const runBlock = () => {
  const match = action.match(/^      run: \|\n((?: {8}.*\n?)+)/m);
  assert.ok(match, 'action.yml must contain a composite run block');
  return match[1].replace(/^ {8}/gm, '');
};

// integration_id: ci-rust-release-build-action-regression
test('action.yml maps release build inputs to the shared script family', () => {
  // Arrange
  const actionPath = path.join(root, 'action.yml');
  // Act
  const action = readFileSync(actionPath, 'utf8');
  // Assert
  assert.match(action, /^name: ci-rust-release-build$/m);
  assert.match(action, /^  using: composite$/m);
  for (const input of [
    'language-profile',
    'platform-manifest',
    'toolchain-version',
    'platform-id',
    'platform-target',
    'authority-path',
    'output-directory',
    'cargo-manifest-path',
    'release-binary-name',
    'release-asset-prefix',
  ]) {
    assert.match(action, new RegExp(`^  ${input}:$`, 'm'));
  }
  assert.match(action, /runtime\/rust-release\/ci-release-build\.sh/);
  assert.doesNotMatch(action, /release-version-prefix/);
  assert.doesNotMatch(action, /CI_RELEASE_VERSION_PREFIX/);
  assert.match(action, /^  completed:$/m);
  assert.match(action, /^    value: \$\{\{ steps\.build\.outputs\.completed \}\}$/m);
  assert.match(action, /^        CI_CARGO_MANIFEST_PATH: \$\{\{ inputs\.cargo-manifest-path \}\}$/m);
  assert.match(action, /^        CI_RELEASE_BINARY_NAME: \$\{\{ inputs\.release-binary-name \}\}$/m);
  for (const name of [
    'ci-release-build.sh',
    'ci-release-build.ps1',
    'package-release-unix.sh',
    'package-release.ps1',
    'verify-release-asset-unix.sh',
    'verify-release-asset.ps1',
    'dist/index.mjs',
  ]) {
    accessSync(path.join(scriptRoot, name), constants.R_OK);
  }
  for (const name of ['ci-release-build.sh', 'package-release-unix.sh', 'verify-release-asset-unix.sh']) {
    accessSync(path.join(scriptRoot, name), constants.X_OK);
  }
});

// contract_id: contract.ci-rust-release-build.outputs
// integration_id: ci-rust-release-build-action
test('composite release build exposes completed only after script success', () => {
  // Arrange
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'a3-ci-github-rust-build-action-'));
  const actionPath = path.join(fixture, 'actions', 'ci-rust-release-build');
  const fixtureScript = path.join(fixture, 'runtime', 'rust-release', 'ci-release-build.sh');
  const output = path.join(fixture, 'github-output');
  try {
    mkdirSync(path.dirname(fixtureScript), { recursive: true });
    mkdirSync(actionPath, { recursive: true });
    writeFileSync(fixtureScript, [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'test "$1" = rust',
      'test "$2" = platform.yml',
      'test "$3" = stable',
      'test "$4" = linux-x64',
      'test "$5" = x86_64-unknown-linux-gnu',
      'test "$6" = authority.json',
      'test "$7" = build/linux-x64',
      'test "$CI_CARGO_MANIFEST_PATH" = Cargo.toml',
      'test "$CI_RELEASE_BINARY_NAME" = example-cli',
      '',
    ].join('\n'));
    chmodSync(fixtureScript, 0o755);
    writeFileSync(output, '');
    const environment = {
      ...process.env,
      GITHUB_ACTION_PATH: actionPath,
      GITHUB_OUTPUT: output,
      LANGUAGE_PROFILE: 'rust',
      PLATFORM_MANIFEST: 'platform.yml',
      TOOLCHAIN_VERSION: 'stable',
      PLATFORM_ID: 'linux-x64',
      PLATFORM_TARGET: 'x86_64-unknown-linux-gnu',
      AUTHORITY_PATH: 'authority.json',
      OUTPUT_DIRECTORY: 'build/linux-x64',
      CI_CARGO_MANIFEST_PATH: 'Cargo.toml',
      CI_RELEASE_BINARY_NAME: 'example-cli',
      CI_RELEASE_ASSET_PREFIX: 'example-cli',
    };
    // Act
    const success = spawnSync('bash', ['-euo', 'pipefail', '-c', runBlock()], {
      encoding: 'utf8',
      env: environment,
    });
    // Assert
    assert.equal(success.status, 0, success.stderr);
    assert.equal(readFileSync(output, 'utf8'), 'completed=true\n');

    // Arrange
    writeFileSync(output, '');
    // Act
    const failure = spawnSync('bash', ['-euo', 'pipefail', '-c', runBlock()], {
      encoding: 'utf8',
      env: { ...environment, PLATFORM_ID: 'macos-arm64' },
    });
    // Assert
    assert.notEqual(failure.status, 0);
    assert.equal(readFileSync(output, 'utf8'), '');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
