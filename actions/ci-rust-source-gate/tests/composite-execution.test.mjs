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

describe("contract.ci-rust-source-gate.outputs", () => {
  describe("ci-rust-source-gate-action", () => {
    // contract_id: contract.ci-rust-source-gate.outputs
    // flow_id: ci-rust-source-gate-action
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
        expect(success.status, success.stderr).toBe(0);
        expect(readFileSync(output, 'utf8')).toBe('verified=true\n');

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
        expect(failure.status).not.toBe(0);
        expect(readFileSync(output, 'utf8')).toBe('');
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    });
  });
});
