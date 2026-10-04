import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, test, expect } from 'vitest';

import { actionEntrypointArguments } from '../../../tests/support/action-entrypoint';

describe.each(['source', 'dist'] as const)('%s entrypoint', (surface) => {
  const entrypointArgs = actionEntrypointArguments(path.resolve(__dirname, '..'), surface);
// contract_id: contract.ci-release-publication-control.outputs
// integration_id: ci-release-publication-control-contract-entrypoint
test('entrypoint creates and verifies a publication request', () => {
  // Arrange
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-publication-entry-'));
  const output = path.join(root, 'output');
  const notes = '# Release\n';
  fs.writeFileSync(output, '');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output, INPUT_OPERATION: 'create-request', 'INPUT_ROOT-DIRECTORY': root, 'INPUT_RELEASE-REQUEST-RUN-ID': '11', 'INPUT_REQUEST-WORKFLOW-RUN-ID': '22', 'INPUT_REQUEST-HEAD-SHA': 'a'.repeat(40), 'INPUT_RELEASE-IDENTITY': 'v1', 'INPUT_RELEASE-NOTES': notes, 'INPUT_APPROVAL-ID': 'approval', 'INPUT_APPROVAL-EXPIRES-AT': '2999-01-01T00:00:00Z', 'INPUT_APPROVAL-BODY-SHA256': crypto.createHash('sha256').update(notes).digest('hex') } as Record<string, string>;
  const entrypoint = entrypointArgs;

  // Act
  const created = spawnSync(process.execPath, [...entrypoint], { env, encoding: 'utf8' });

  // Assert
  expect(created.status).toBe(0);
  expect(fs.existsSync(path.join(root, 'release-publication-request/request.json'))).toBeTruthy();

  // Arrange
  fs.writeFileSync(output, '');

  // Act
  const verified = spawnSync(process.execPath, [...entrypoint], { env: { ...env, INPUT_OPERATION: 'verify-publication-request' }, encoding: 'utf8' });

  // Assert
  expect(verified.status).toBe(0);
  expect(fs.readFileSync(output, 'utf8')).toMatch(/status<<[^\n]+\nsuccess\n/);
  expect(fs.readFileSync(output, 'utf8')).toMatch(/request-run-id<<[^\n]+\n11\n/);

  // Arrange
  const files = ['release-publication-request/request.json', 'release-publication-request/request.json.sha256', 'release-notes-handoff/release-notes.json', 'release-notes-handoff/release-notes-approval.json'];
  const saved = files.map((file) => fs.readFileSync(path.join(root, file), 'utf8'));
  fs.writeFileSync(output, '');
  // Act
  const replay = spawnSync(process.execPath, [...entrypoint], { env: { ...env, 'INPUT_APPROVAL-ID': 'replacement-approval' }, encoding: 'utf8' });
  // Assert
  expect(replay.status).not.toBe(0);
  expect(fs.readFileSync(output, 'utf8')).toMatch(/status<<[^\n]+\nfailed\n/);
  expect(fs.readFileSync(output, 'utf8')).not.toMatch(/request-run-id<</);
  expect(files.map((file) => fs.readFileSync(path.join(root, file), 'utf8'))).toStrictEqual(saved);
  fs.rmSync(root, { recursive: true, force: true });
});

// contract_id: contract.ci-release-publication-control.outputs
// integration_id: ci-release-publication-control-contract-entrypoint
test('entrypoint rejects a changed approval ID', () => {
  // Arrange
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-publication-entry-rejected-'));
  const output = path.join(root, 'output');
  const bodyDigest = crypto.createHash('sha256').update('# Release\n').digest('hex');
  fs.writeFileSync(output, '');
  fs.mkdirSync(path.join(root, 'authority'));
  fs.writeFileSync(path.join(root, 'authority/publication-request.json'), JSON.stringify({ approvalId: 'approval-1', approvalExpiresAt: '2999-01-01T00:00:00Z', releaseNotesBodySha256: bodyDigest }));
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output, INPUT_OPERATION: 'verify-approval', 'INPUT_ROOT-DIRECTORY': root, 'INPUT_APPROVAL-ID': 'changed', 'INPUT_APPROVAL-BODY-SHA256': bodyDigest } as Record<string, string>;
  const entrypoint = entrypointArgs;

  // Act
  const result = spawnSync(process.execPath, [...entrypoint], { env, encoding: 'utf8' });

  // Assert
  expect(result.status).not.toBe(0);
  expect(fs.readFileSync(output, 'utf8')).toMatch(/failed/);
  fs.rmSync(root, { recursive: true, force: true });
});

});
