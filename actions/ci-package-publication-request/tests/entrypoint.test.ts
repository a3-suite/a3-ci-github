import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, test, expect } from 'vitest';

import { actionEntrypointArguments } from '../../../tests/support/action-entrypoint';
import { rejectedRequestTriggerEnvironments, requestTriggerEnvironment } from '../../../runtime/workflow-run/tests/request-trigger-fixture';

describe.each(['source', 'dist'] as const)('%s entrypoint', (surface) => {
  const entrypointArgs = actionEntrypointArguments(path.resolve(__dirname, '..'), surface);
// contract_id: contract.ci-package-publication-request.outputs
// flow_id: ci-package-publication-request-contract-entrypoint
test('entrypoint creates and verifies a request', () => {
  // Arrange
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-package-entry-'));
  const output = path.join(root, 'output');
  const request = path.join(root, 'request.json');
  fs.writeFileSync(output, '');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output, INPUT_OPERATION: 'create', 'INPUT_REQUEST-PATH': request, 'INPUT_SOURCE-SHA': 'a'.repeat(40), INPUT_VERSION: '1.2.3', 'INPUT_TARGET-IDENTITY': 'npm:pkg', 'INPUT_LANGUAGE-PROFILE': 'node', INPUT_TOOLCHAIN: '22' } as Record<string, string>;
  const entrypoint = entrypointArgs;

  const fields = {
    status: 'success',
    'request-path': request,
    'source-sha': 'a'.repeat(40),
    version: '1.2.3',
    'target-identity': 'npm:pkg',
    'language-profile': 'node',
    toolchain: '22',
  };
  const expectRequestOutputs = () => {
    const contents = fs.readFileSync(output, 'utf8');
    for (const [name, value] of Object.entries(fields)) {
      expect(contents.match(new RegExp(`^${name}<<([^\\r\\n]+)\\r?\\n([^\\r\\n]+)\\r?\\n\\1$`, 'm'))?.[2]).toBe(value);
    }
  };

  // Act
  const result = spawnSync(process.execPath, [...entrypoint], { env, encoding: 'utf8' });

  // Assert
  expect(result.status).toBe(0);
  expect(JSON.parse(fs.readFileSync(request, 'utf8')).sourceSha).toBe('a'.repeat(40));
  expectRequestOutputs();

  // Arrange
  fs.writeFileSync(output, '');

  // Act
  const verified = spawnSync(process.execPath, [...entrypoint], { env: { ...env, INPUT_OPERATION: 'verify', 'INPUT_SOURCE-SHA': '', 'INPUT_EXPECTED-SOURCE-SHA': 'a'.repeat(40) }, encoding: 'utf8' });

  // Assert
  expect(verified.status).toBe(0);
  expectRequestOutputs();
  const writeFailure = spawnSync(process.execPath, [...entrypoint], {
    env: { ...env, 'INPUT_REQUEST-PATH': path.join(root, 'second-request.json'), GITHUB_OUTPUT: root },
    encoding: 'utf8',
  });
  expect(writeFailure.status).toBe(1);
  expect(writeFailure.stderr).toMatch(/^ci-failure-diagnostic:.*"stage":"output-write"/m);
  fs.rmSync(root, { recursive: true, force: true });
});

// flow_id: ci-package-publication-request-contract-entrypoint
test('entrypoint rejects a create replay without rewriting the request', () => {
  // Arrange
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-package-entry-replay-'));
  const output = path.join(root, 'output');
  const request = path.join(root, 'request.json');
  fs.writeFileSync(output, '');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output, INPUT_OPERATION: 'create', 'INPUT_REQUEST-PATH': request, 'INPUT_SOURCE-SHA': 'a'.repeat(40), INPUT_VERSION: '1.2.3', 'INPUT_TARGET-IDENTITY': 'npm:pkg', 'INPUT_LANGUAGE-PROFILE': 'node', INPUT_TOOLCHAIN: '22' } as Record<string, string>;
  const entrypoint = entrypointArgs;
  const created = spawnSync(process.execPath, [...entrypoint], { env, encoding: 'utf8' });
  if (created.status !== 0) throw new Error('package request test setup failed');
  const saved = fs.readFileSync(request, 'utf8');
  fs.writeFileSync(output, '');
  // Act
  const replay = spawnSync(process.execPath, [...entrypoint], { env: { ...env, INPUT_VERSION: '9.9.9' }, encoding: 'utf8' });
  // Assert
  expect(replay.status, replay.stderr).toBe(1);
  expect(fs.readFileSync(output, 'utf8')).toMatch(/status<<[^\n]+\nfailed\n/);
  expect(fs.readFileSync(output, 'utf8')).not.toMatch(/(?:source-sha|request-path)<</);
  expect(fs.readFileSync(request, 'utf8')).toBe(saved);
  fs.rmSync(root, { recursive: true, force: true });
});

// contract_id: contract.ci-package-publication-request.outputs
// flow_id: ci-package-publication-request-contract-entrypoint
test('entrypoint rejects a source SHA mismatch', () => {
  // Arrange
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-package-entry-rejected-'));
  const output = path.join(root, 'output');
  const request = path.join(root, 'request.json');
  fs.writeFileSync(output, '');
  const entrypoint = entrypointArgs;
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output, INPUT_OPERATION: 'create', 'INPUT_REQUEST-PATH': request, 'INPUT_SOURCE-SHA': 'a'.repeat(40), INPUT_VERSION: '1.2.3', 'INPUT_TARGET-IDENTITY': 'npm:pkg', 'INPUT_LANGUAGE-PROFILE': 'node', INPUT_TOOLCHAIN: '22' } as Record<string, string>;
  const created = spawnSync(process.execPath, [...entrypoint], { env, encoding: 'utf8' });
  if (created.status !== 0) throw new Error('package request test setup failed');
  fs.writeFileSync(output, '');

  // Act
  const result = spawnSync(process.execPath, [...entrypoint], { env: { ...env, INPUT_OPERATION: 'verify', 'INPUT_EXPECTED-SOURCE-SHA': 'b'.repeat(40) }, encoding: 'utf8' });

  // Assert
  expect(result.status, result.stderr).toBe(1);
  expect(fs.readFileSync(output, 'utf8')).toMatch(/failed/);
  const line = result.stderr.split('\n').find((value) => value.startsWith('ci-failure-diagnostic:'));
  expect(JSON.parse(line?.slice('ci-failure-diagnostic:'.length) ?? '{}')).toMatchObject({
    classification: { subject: 'ci-package-publication-request', stage: 'request-verify', reason: 'package-publication-source-sha-mismatch' },
    context: { inputs: { expectedSourceSha: 'b'.repeat(40) } },
    comparison: { field: 'source-sha', expected: 'b'.repeat(40), observed: 'a'.repeat(40) },
  });
  fs.rmSync(root, { recursive: true, force: true });
});

// contract_id: contract.ci-package-publication-request.outputs
// flow_id: ci-package-publication-request-contract-entrypoint
test('entrypoint verifies the triggering request workflow run before artifact download', () => {
  // Arrange
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-request-trigger-'));
  const output = path.join(root, 'output');
  fs.writeFileSync(output, '');
  const base = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output, INPUT_OPERATION: 'verify-trigger', 'INPUT_REQUEST-PATH': path.join(root, 'request.json') } as Record<string, string>;

  // Act
  const accepted = spawnSync(process.execPath, [...entrypointArgs], { env: { ...base, ...requestTriggerEnvironment(root, 'package-publication-request') }, encoding: 'utf8' });
  const acceptedOutput = fs.readFileSync(output, 'utf8');
  expect(accepted.status).toBe(0);
  expect(acceptedOutput).toMatch(/status<<[^\n]+\nsuccess\n/);

  for (const { field, reason, env } of rejectedRequestTriggerEnvironments(root, 'package-publication-request')) {
    fs.writeFileSync(output, '');
    const rejected = spawnSync(process.execPath, [...entrypointArgs], { env: { ...base, ...env }, encoding: 'utf8' });
    expect(rejected.status, field).toBe(1);
    expect(fs.readFileSync(output, 'utf8'), field).toMatch(/status<<[^\n]+\nfailed\n/);
    const line = rejected.stderr.split('\n').find((value) => value.startsWith('ci-failure-diagnostic:'));
    const diagnostic = JSON.parse(line?.slice('ci-failure-diagnostic:'.length) ?? '{}');
    expect(diagnostic, field).toMatchObject({
      classification: { subject: 'ci-package-publication-request', stage: 'request-trigger', reason },
    });
    if (reason === 'request-trigger-mismatch') expect(diagnostic.comparison.field, field).toBe(field);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

});
