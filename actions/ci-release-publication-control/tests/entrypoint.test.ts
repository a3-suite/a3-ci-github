import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { describe, test, expect } from 'vitest';

import { publicationRequestInputs } from '../../../runtime/repository/action-reference-fixtures.mjs';

import { actionEntrypointArguments } from '../../../tests/support/action-entrypoint';
import { rejectedRequestTriggerEnvironments, requestTriggerEnvironment } from '../../../runtime/workflow-run/tests/request-trigger-fixture';

describe.each(['source', 'dist'] as const)('%s entrypoint', (surface) => {
  const entrypointArgs = actionEntrypointArguments(path.resolve(__dirname, '..'), surface);
// contract_id: contract.ci-release-publication-control.outputs
// flow_id: ci-release-publication-control-contract-entrypoint
test('entrypoint creates and verifies a publication request', () => {
  // Arrange
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-publication-entry-'));
  const output = path.join(root, 'output');
  const notes = '# Release\n';
  fs.writeFileSync(output, '');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output, INPUT_OPERATION: 'create-request', 'INPUT_ROOT-DIRECTORY': root, 'INPUT_RELEASE-REQUEST-RUN-ID': '11', 'INPUT_REQUEST-WORKFLOW-RUN-ID': '22', 'INPUT_REQUEST-HEAD-SHA': 'a'.repeat(40), 'INPUT_RELEASE-IDENTITY': 'v1.2.3', 'INPUT_RELEASE-VERSION': '1.2.3', 'INPUT_TARGET-IDENTITY': 'owner/project', 'INPUT_RELEASE-NOTES': notes, 'INPUT_APPROVAL-ID': 'approval', 'INPUT_APPROVAL-EXPIRES-AT': '2999-01-01T00:00:00Z', 'INPUT_APPROVAL-BODY-SHA256': crypto.createHash('sha256').update(notes).digest('hex') } as Record<string, string>;
  const entrypoint = entrypointArgs;

  // Act
  const created = spawnSync(process.execPath, [...entrypoint], { env, encoding: 'utf8' });

  // Assert
  expect(created.status).toBe(0);
  expect(fs.readFileSync(output, 'utf8')).toMatch(/status<<[^\n]+\nsuccess\n/);
  expect(fs.existsSync(path.join(root, 'release-publication-request/request.json'))).toBeTruthy();

  // Arrange
  fs.writeFileSync(output, '');

  // Act
  const verified = spawnSync(process.execPath, [...entrypoint], { env: { ...env, INPUT_OPERATION: 'verify-publication-request', 'INPUT_RELEASE-VERSION': '', 'INPUT_TARGET-IDENTITY': '' }, encoding: 'utf8' });

  // Assert
  expect(verified.status).toBe(0);
  expect(fs.readFileSync(output, 'utf8')).toMatch(/status<<[^\n]+\nsuccess\n/);
  expect(fs.readFileSync(output, 'utf8')).toMatch(/request-run-id<<[^\n]+\n11\n/);

  // Arrange
  fs.writeFileSync(output, '');
  // Act
  const replay = spawnSync(process.execPath, [...entrypoint], { env: { ...env, 'INPUT_APPROVAL-ID': 'replacement-approval' }, encoding: 'utf8' });
  // Assert
  expect(replay.status, replay.stderr).toBe(1);
  expect(fs.readFileSync(output, 'utf8')).toMatch(/status<<[^\n]+\nfailed\n/);
  expect(fs.readFileSync(output, 'utf8')).not.toMatch(/request-run-id<</);

  const unwritable = path.join(root, 'unwritable-action-output');
  fs.mkdirSync(unwritable);
  const writeFailure = spawnSync(process.execPath, [...entrypoint], {
    env: { ...env, GITHUB_OUTPUT: unwritable, 'INPUT_ROOT-DIRECTORY': unwritable },
    encoding: 'utf8',
  });
  expect(writeFailure.status).toBe(1);
  expect(writeFailure.stderr).toMatch(/^ci-failure-diagnostic:.*"stage":"output-write"/m);
  expect(fs.existsSync(path.join(unwritable, 'release-publication-request/request.json'))).toBe(true);

  const interruptedRoot = path.join(root, 'interrupted');
  const notesPath = path.join(interruptedRoot, 'release-notes-handoff', 'release-notes.json');
  const driver = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const write = fs.writeFileSync;
    fs.writeFileSync = (destination, ...args) => {
      if (destination === ${JSON.stringify(notesPath)}) throw Object.assign(new Error('fixture write failure'), { code: 'EACCES' });
      return write(destination, ...args);
    };
    syncBuiltinESMExports();
    await import(${JSON.stringify(pathToFileURL(entrypoint.at(-1)!).href)});
  `;
  const interrupted = spawnSync(process.execPath, [...entrypoint.slice(0, -1), '--input-type=module', '-e', driver], {
    env: { ...env, 'INPUT_ROOT-DIRECTORY': interruptedRoot },
    encoding: 'utf8',
  });
  expect(interrupted.status).toBe(1);
  expect(interrupted.stderr).toMatch(/^ci-failure-diagnostic:.*"stage":"request-and-notes-write"/m);
  expect(fs.existsSync(path.join(interruptedRoot, 'release-publication-request/request.json'))).toBe(true);
  expect(fs.existsSync(notesPath)).toBe(false);
  fs.rmSync(root, { recursive: true, force: true });
});

// contract_id: contract.ci-release-publication-control.outputs
// flow_id: ci-release-publication-control-contract-entrypoint
test('entrypoint keeps the existing handoff files when it rejects a replay', (t) => {
  // Arrange
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-publication-entry-replay-'));
  t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, 'output');
  fs.writeFileSync(output, '');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output, ...publicationRequestInputs(root) } as Record<string, string>;
  expect(spawnSync(process.execPath, [...entrypointArgs], { env, encoding: 'utf8' }).status).toBe(0);
  const files = ['release-publication-request/request.json', 'release-publication-request/request.json.sha256', 'release-notes-handoff/release-notes.json', 'release-notes-handoff/release-notes-approval.json'];
  const saved = files.map((file) => fs.readFileSync(path.join(root, file)));
  // Act
  const replay = spawnSync(process.execPath, [...entrypointArgs], { env: { ...env, 'INPUT_APPROVAL-ID': 'replacement-approval' }, encoding: 'utf8' });
  // Assert
  expect(replay.status, replay.stderr).toBe(1);
  expect(replay.stderr).toMatch(/^ci-failure-diagnostic:.*"reason":"release-publication-output-already-exists"/m);
  const line = replay.stderr.split('\n').find((value) => value.startsWith('ci-failure-diagnostic:'));
  expect(JSON.parse(line?.slice('ci-failure-diagnostic:'.length) ?? '{}')).toMatchObject({
    classification: { subject: 'ci-release-publication-control', stage: 'create-request' },
  });
  expect(files.map((file) => fs.readFileSync(path.join(root, file)))).toStrictEqual(saved);
});

// contract_id: contract.ci-release-publication-control.outputs
// flow_id: ci-release-publication-control-contract-entrypoint
test('entrypoint rejects a v1 publication request on verification', (t) => {
  // Arrange
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-publication-entry-v1-'));
  t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, 'output');
  fs.writeFileSync(output, '');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output, ...publicationRequestInputs(root) } as Record<string, string>;
  expect(spawnSync(process.execPath, entrypointArgs, { env, encoding: 'utf8' }).status).toBe(0);
  const requestDirectory = path.join(root, 'release-publication-request');
  const request = { ...JSON.parse(fs.readFileSync(path.join(requestDirectory, 'request.json'), 'utf8')), schema: 'ci.release-publication-request.v1' };
  const content = `${JSON.stringify(request)}\n`;
  fs.writeFileSync(path.join(requestDirectory, 'request.json'), content);
  fs.writeFileSync(path.join(requestDirectory, 'request.json.sha256'), `${crypto.createHash('sha256').update(content).digest('hex')}  request.json\n`);
  fs.writeFileSync(output, '');
  const requestDirectories = () => ['release-publication-request', 'release-notes-handoff'].map((name) => fs.existsSync(path.join(root, name)));
  const before = requestDirectories();
  // Act
  const result = spawnSync(process.execPath, entrypointArgs, { env: { ...env, INPUT_OPERATION: 'verify-publication-request', 'INPUT_RELEASE-VERSION': '', 'INPUT_TARGET-IDENTITY': '' }, encoding: 'utf8' });
  // Assert
  expect(result.status, result.stderr).toBe(1);
  expect(fs.readFileSync(output, 'utf8')).toMatch(/status<<[^\n]+\nfailed\n/);
  expect(fs.readFileSync(output, 'utf8')).not.toMatch(/request-run-id<</);
  expect(requestDirectories()).toStrictEqual(before);
});

// contract_id: contract.ci-release-publication-control.outputs
// flow_id: ci-release-publication-control-contract-entrypoint
test('entrypoint rejects missing owner decision before creating artifacts', (t) => {
  // Arrange
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-publication-entry-owner-'));
  t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, 'output');
  const input = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output, ...publicationRequestInputs(root) };
  for (const missing of ['INPUT_RELEASE-VERSION', 'INPUT_TARGET-IDENTITY']) {
    fs.writeFileSync(output, '');
    // Act
    const result = spawnSync(process.execPath, entrypointArgs, { env: { ...input, [missing]: '' }, encoding: 'utf8' });
    // Assert
    expect(result.status, result.stderr).toBe(1);
    expect(fs.readFileSync(output, 'utf8')).toMatch(/failed/);
    expect(fs.existsSync(path.join(root, 'release-publication-request'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'release-notes-handoff'))).toBe(false);
  }
});

// contract_id: contract.ci-release-publication-control.outputs
// flow_id: ci-release-publication-control-contract-entrypoint
test('entrypoint rejects a changed approval ID', () => {
  // Arrange
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-publication-entry-rejected-'));
  const output = path.join(root, 'output');
  const bodyDigest = crypto.createHash('sha256').update('# Release\n').digest('hex');
  fs.writeFileSync(output, '');
  fs.mkdirSync(path.join(root, 'authority'));
  fs.writeFileSync(path.join(root, 'authority/publication-request.json'), JSON.stringify({ schema: 'ci.release-publication-request.v2', releaseVersion: '1.2.3', targetIdentity: 'owner/project', releaseIdentity: 'v1.2.3', approvalId: 'approval-1', approvalExpiresAt: '2999-01-01T00:00:00Z', releaseNotesBodySha256: bodyDigest }));
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output, INPUT_OPERATION: 'verify-approval', 'INPUT_ROOT-DIRECTORY': root, 'INPUT_APPROVAL-ID': 'changed', 'INPUT_APPROVAL-BODY-SHA256': bodyDigest } as Record<string, string>;
  const entrypoint = entrypointArgs;

  // Act
  const result = spawnSync(process.execPath, [...entrypoint], { env, encoding: 'utf8' });

  // Assert
  expect(result.status, result.stderr).toBe(1);
  expect(fs.readFileSync(output, 'utf8')).toMatch(/failed/);
  expect(fs.existsSync(path.join(root, 'release-publication-request'))).toBe(false);
  expect(fs.existsSync(path.join(root, 'release-notes-handoff'))).toBe(false);
  fs.writeFileSync(output, '');
  const approved = spawnSync(process.execPath, [...entrypoint], {
    env: { ...env, 'INPUT_APPROVAL-ID': 'approval-1' },
    encoding: 'utf8',
  });
  expect(approved.status).toBe(0);
  expect(fs.readFileSync(output, 'utf8')).toMatch(/status<<[^\n]+\nsuccess\n/);
  fs.rmSync(root, { recursive: true, force: true });
});

// contract_id: contract.ci-release-publication-control.outputs
// flow_id: ci-release-publication-control-contract-entrypoint
test('entrypoint rejects release notes that differ from the approved body digest', () => {
  // Arrange
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-publication-entry-digest-'));
  const output = path.join(root, 'output');
  const notes = '# Release\n';
  const approvedDigest = crypto.createHash('sha256').update('# Approved\n').digest('hex');
  fs.writeFileSync(output, '');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output, INPUT_OPERATION: 'create-request', 'INPUT_ROOT-DIRECTORY': root, 'INPUT_RELEASE-REQUEST-RUN-ID': '11', 'INPUT_REQUEST-WORKFLOW-RUN-ID': '22', 'INPUT_REQUEST-HEAD-SHA': 'a'.repeat(40), 'INPUT_RELEASE-IDENTITY': 'v1.2.3', 'INPUT_RELEASE-VERSION': '1.2.3', 'INPUT_TARGET-IDENTITY': 'owner/project', 'INPUT_RELEASE-NOTES': notes, 'INPUT_APPROVAL-ID': 'approval', 'INPUT_APPROVAL-EXPIRES-AT': '2999-01-01T00:00:00Z', 'INPUT_APPROVAL-BODY-SHA256': approvedDigest } as Record<string, string>;

  // Act
  const result = spawnSync(process.execPath, [...entrypointArgs], { env, encoding: 'utf8' });

  // Assert
  expect(result.status, result.stderr).toBe(1);
  const line = result.stderr.split('\n').find((value) => value.startsWith('ci-failure-diagnostic:'));
  expect(JSON.parse(line?.slice('ci-failure-diagnostic:'.length) ?? '{}')).toMatchObject({
    classification: { subject: 'ci-release-publication-control', stage: 'create-request' },
    context: { inputs: { requestHeadSha: 'a'.repeat(40), releaseRequestRunId: '11', requestWorkflowRunId: '22' } },
    comparison: { field: 'approval-body-sha256', expected: approvedDigest, observed: crypto.createHash('sha256').update(notes).digest('hex') },
  });
  expect(result.stderr).not.toContain('# Release');
  expect(fs.existsSync(path.join(root, 'release-publication-request'))).toBe(false);
  expect(fs.existsSync(path.join(root, 'release-notes-handoff'))).toBe(false);
  fs.rmSync(root, { recursive: true, force: true });
});

// contract_id: contract.ci-release-publication-control.outputs
// flow_id: ci-release-publication-control-contract-entrypoint
test('entrypoint rejects the authority-internal provenance operation', () => {
  // Arrange
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-publication-entry-operation-'));
  const output = path.join(root, 'output');
  fs.writeFileSync(output, '');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output, INPUT_OPERATION: 'verify-provenance', 'INPUT_ROOT-DIRECTORY': root } as Record<string, string>;

  // Act
  const result = spawnSync(process.execPath, [...entrypointArgs], { env, encoding: 'utf8' });

  // Assert
  expect(result.status, result.stderr).toBe(1);
  expect(fs.readFileSync(output, 'utf8')).toMatch(/status<<[^\n]+\nfailed\n/);
  const line = result.stderr.split('\n').find((value) => value.startsWith('ci-failure-diagnostic:'));
  expect(JSON.parse(line?.slice('ci-failure-diagnostic:'.length) ?? '{}')).toMatchObject({
    classification: { subject: 'ci-release-publication-control', stage: 'control-input', reason: 'release-publication-operation-invalid' },
  });
  fs.rmSync(root, { recursive: true, force: true });
});

// contract_id: contract.ci-release-publication-control.outputs
// flow_id: ci-release-publication-control-contract-entrypoint
test('entrypoint verifies the triggering request workflow run before artifact download', () => {
  // Arrange
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-request-trigger-'));
  const output = path.join(root, 'output');
  fs.writeFileSync(output, '');
  const base = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output, INPUT_OPERATION: 'verify-trigger', 'INPUT_ROOT-DIRECTORY': root } as Record<string, string>;

  // Act
  const accepted = spawnSync(process.execPath, [...entrypointArgs], { env: { ...base, ...requestTriggerEnvironment(root, 'release-publication-request') }, encoding: 'utf8' });
  const acceptedOutput = fs.readFileSync(output, 'utf8');
  expect(accepted.status).toBe(0);
  expect(acceptedOutput).toMatch(/status<<[^\n]+\nsuccess\n/);

  for (const { field, reason, env } of rejectedRequestTriggerEnvironments(root, 'release-publication-request')) {
    fs.writeFileSync(output, '');
    const rejected = spawnSync(process.execPath, [...entrypointArgs], { env: { ...base, ...env }, encoding: 'utf8' });
    expect(rejected.status, field).toBe(1);
    expect(fs.readFileSync(output, 'utf8'), field).toMatch(/status<<[^\n]+\nfailed\n/);
    const line = rejected.stderr.split('\n').find((value) => value.startsWith('ci-failure-diagnostic:'));
    const diagnostic = JSON.parse(line?.slice('ci-failure-diagnostic:'.length) ?? '{}');
    expect(diagnostic, field).toMatchObject({
      classification: { subject: 'ci-release-publication-control', stage: 'control-operation', reason },
    });
    if (reason === 'request-trigger-mismatch') expect(diagnostic.comparison.field, field).toBe(field);
  }
  expect(fs.existsSync(path.join(root, 'release-publication-request'))).toBe(false);
  expect(fs.existsSync(path.join(root, 'release-notes-handoff'))).toBe(false);
  fs.rmSync(root, { recursive: true, force: true });
});

});
