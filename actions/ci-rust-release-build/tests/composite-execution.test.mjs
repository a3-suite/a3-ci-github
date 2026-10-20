import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, describe, expect } from 'vitest';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const action = readFileSync(path.join(root, 'action.yml'), 'utf8');

const runBlock = () => {
  const match = action.match(/^      run: \|\n((?: {8}.*\n?)+)/m);
  expect(match, 'action.yml must contain a composite run block').toBeTruthy();
  return match[1].replace(/^ {8}/gm, '');
};

describe("contract.ci-rust-release-build.outputs", () => {
  describe("ci-rust-release-build-action", () => {
    // contract_id: contract.ci-rust-release-build.outputs
    // flow_id: ci-rust-release-build-action
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
        expect(success.status, success.stderr).toBe(0);
        expect(readFileSync(output, 'utf8')).toBe('completed=true\n');

        // Arrange
        writeFileSync(output, '');
        // Act
        const failure = spawnSync('bash', ['-euo', 'pipefail', '-c', runBlock()], {
          encoding: 'utf8',
          env: { ...environment, PLATFORM_ID: 'macos-arm64' },
        });
        // Assert
        expect(failure.status).not.toBe(0);
        expect(readFileSync(output, 'utf8')).toBe('');
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    });
  });
});
