import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, test, expect } from 'vitest';

import { actionEntrypointArguments } from '../../../tests/support/action-entrypoint';

describe.each(['source', 'dist'] as const)('%s entrypoint', (surface) => {
  const entrypointArgs = actionEntrypointArguments(path.resolve(__dirname, '..'), surface);
const root = path.resolve(__dirname, '..');

// contract_id: contract.ci-release-request-handoff.outputs
// integration_id: ci-release-request-handoff-contract-entrypoint
test('entrypoint writes a tag handoff', () => {
  // Arrange
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-request-entrypoint-'));
  const output = path.join(tempRoot, 'outputs');
  const handoff = path.join(tempRoot, 'handoff');
  fs.writeFileSync(output, '', 'utf8');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output, 'INPUT_OUTPUT-DIRECTORY': handoff, 'INPUT_TAG-SOURCE-SHA': 'a'.repeat(40), 'INPUT_TAG-OBJECT-SHA': 'b'.repeat(40), 'INPUT_GITHUB-REF': 'refs/tags/v1.2.3', 'INPUT_GITHUB-REF-NAME': 'v1.2.3', 'INPUT_REQUEST-RUN-ID': '42', 'INPUT_REQUEST-ACTOR': 'release-operator' } as Record<string, string>;
  // Act
  const result = spawnSync(process.execPath, [...entrypointArgs], { cwd: root, env, encoding: 'utf8' });
  // Assert
  expect(result.status).toBe(0);
  const outputs = fs.readFileSync(output, 'utf8');
  expect(outputs.match(/^request-path<<([^\n]+)\n([^\n]+)\n\1$/m)?.[2]).toBe(path.join(handoff, 'release-request.json'));
  expect(fs.existsSync(path.join(handoff, 'release-request.json'))).toBeTruthy();

  // Arrange
  const files = ['release-request.json', 'release-request.json.sha256'];
  const saved = files.map((file) => fs.readFileSync(path.join(handoff, file), 'utf8'));
  fs.writeFileSync(output, '');
  // Act
  const replay = spawnSync(process.execPath, [...entrypointArgs], { cwd: root, env: { ...env, 'INPUT_TAG-SOURCE-SHA': 'c'.repeat(40) }, encoding: 'utf8' });
  // Assert
  expect(replay.status).not.toBe(0);
  expect(fs.readFileSync(output, 'utf8')).toBe('');
  expect(files.map((file) => fs.readFileSync(path.join(handoff, file), 'utf8'))).toStrictEqual(saved);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

// contract_id: contract.ci-release-request-handoff.outputs
// integration_id: ci-release-request-handoff-contract-entrypoint
test('entrypoint rejects a tag ref mismatch', () => {
  // Arrange
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-request-entrypoint-rejected-'));
  const output = path.join(tempRoot, 'outputs');
  const handoff = path.join(tempRoot, 'handoff');
  fs.writeFileSync(output, '', 'utf8');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output, 'INPUT_OUTPUT-DIRECTORY': handoff, 'INPUT_TAG-SOURCE-SHA': 'a'.repeat(40), 'INPUT_TAG-OBJECT-SHA': 'b'.repeat(40), 'INPUT_GITHUB-REF': 'refs/tags/v1.2.4', 'INPUT_GITHUB-REF-NAME': 'v1.2.3', 'INPUT_REQUEST-RUN-ID': '42', 'INPUT_REQUEST-ACTOR': 'release-operator' } as Record<string, string>;

  // Act
  const result = spawnSync(process.execPath, [...entrypointArgs], { cwd: root, env, encoding: 'utf8' });

  // Assert
  expect(result.status).not.toBe(0);
  expect(fs.readFileSync(output, 'utf8')).toBe('');
  expect(fs.existsSync(path.join(handoff, 'release-request.json'))).toBe(false);
  expect(fs.existsSync(path.join(handoff, 'release-request.json.sha256'))).toBe(false);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

});
