import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, test, expect } from 'vitest';

import { actionEntrypointArguments } from '../../../tests/support/action-entrypoint';

describe.each(['source', 'dist'] as const)('%s entrypoint', (surface) => {
  const entrypointArgs = actionEntrypointArguments(path.resolve(__dirname, '..'), surface);
const root = path.resolve(__dirname, '..');
const diagnosticOf = (stderr: string): Record<string, unknown> =>
  JSON.parse(stderr.split('\n').find((line) => line.startsWith('ci-failure-diagnostic:'))?.slice('ci-failure-diagnostic:'.length) ?? '{}');

// contract_id: contract.ci-release-request-handoff.outputs
// flow_id: ci-release-request-handoff-contract-entrypoint
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
  const digestPath = path.join(handoff, 'release-request.json.sha256');
  expect(outputs.match(/^request-digest<<([^\n]+)\n([^\n]+)\n\1$/m)?.[2]).toBe(digestPath);
  const request = fs.readFileSync(path.join(handoff, 'release-request.json'));
  expect(JSON.parse(request.toString())).toMatchObject({
    ref: 'refs/tags/v1.2.3',
    tag: 'v1.2.3',
    source_sha: 'a'.repeat(40),
    tag_object_sha: 'b'.repeat(40),
    request_run_id: '42',
    request_actor: 'release-operator',
    version: null,
    version_resolution: 'authority',
  });
  expect(fs.readFileSync(digestPath, 'utf8').split(/\s+/)[0]).toBe(createHash('sha256').update(request).digest('hex'));

  // Arrange
  const files = ['release-request.json', 'release-request.json.sha256'];
  const saved = files.map((file) => fs.readFileSync(path.join(handoff, file), 'utf8'));
  fs.writeFileSync(output, '');
  // Act
  const replay = spawnSync(process.execPath, [...entrypointArgs], { cwd: root, env: { ...env, 'INPUT_TAG-SOURCE-SHA': 'c'.repeat(40) }, encoding: 'utf8' });
  // Assert
  expect(replay.status).not.toBe(0);
  expect(diagnosticOf(replay.stderr)).toMatchObject({
    classification: { stage: 'destination-validation', reason: 'release-request-output-already-exists' },
    comparison: { field: 'request-files', expected: 'absent', observed: 'already-present' },
    'execution-state': { write: 'not-started' },
  });
  expect(fs.readFileSync(output, 'utf8')).toBe('');
  expect(files.map((file) => fs.readFileSync(path.join(handoff, file), 'utf8'))).toStrictEqual(saved);
  const unwritable = spawnSync(process.execPath, [...entrypointArgs], {
    cwd: root,
    env: { ...env, GITHUB_OUTPUT: tempRoot, 'INPUT_OUTPUT-DIRECTORY': path.join(tempRoot, 'second-handoff') },
    encoding: 'utf8',
  });
  expect(unwritable.status).toBe(1);
  expect(diagnosticOf(unwritable.stderr)).toMatchObject({ classification: { stage: 'output-write' } });
  const blockedDirectory = path.join(tempRoot, 'blocked');
  fs.writeFileSync(blockedDirectory, 'existing file');
  const unwritableRequest = spawnSync(process.execPath, [...entrypointArgs], {
    cwd: root,
    env: { ...env, 'INPUT_OUTPUT-DIRECTORY': blockedDirectory },
    encoding: 'utf8',
  });
  expect(unwritableRequest.status).toBe(1);
  expect(diagnosticOf(unwritableRequest.stderr)).toMatchObject({ classification: { stage: 'destination-validation' } });
  const collision = path.join(tempRoot, 'collision');
  const collisionDigest = path.join(collision, 'release-request.json.sha256');
  const preload = `
    import fs from 'node:fs';
    const write = fs.writeFileSync;
    fs.writeFileSync = (file, data, options) => {
      if (file === ${JSON.stringify(collisionDigest)}) write(file, 'concurrent evidence');
      return write(file, data, options);
    };
  `;
  const collided = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, ...entrypointArgs], {
    cwd: root,
    env: { ...env, 'INPUT_OUTPUT-DIRECTORY': collision },
    encoding: 'utf8',
  });
  expect(collided.status).toBe(1);
  expect(diagnosticOf(collided.stderr)).toMatchObject({
    classification: { stage: 'request-digest-write' },
    'execution-state': { write: 'request-output-may-be-partial' },
  });
  expect(fs.readFileSync(collisionDigest, 'utf8')).toBe('concurrent evidence');
  const missingSource = spawnSync(process.execPath, [...entrypointArgs], {
    cwd: root,
    env: { ...env, 'INPUT_TAG-SOURCE-SHA': '' },
    encoding: 'utf8',
  });
  expect(missingSource.status).toBe(1);
  expect(diagnosticOf(missingSource.stderr)).toMatchObject({ classification: { stage: 'request-write', reason: 'input-missing' } });
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

// contract_id: contract.ci-release-request-handoff.outputs
// flow_id: ci-release-request-handoff-contract-entrypoint
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
  expect(diagnosticOf(result.stderr)).toMatchObject({
    classification: { subject: 'ci-release-request-handoff', stage: 'request-identity-validation', reason: 'github-tag-ref-mismatch' },
    comparison: { field: 'github-ref', expected: 'refs/tags/v1.2.3', observed: 'refs/tags/v1.2.4' },
    'execution-state': { write: 'not-started' },
  });
  expect(fs.readFileSync(output, 'utf8')).toBe('');
  expect(fs.existsSync(path.join(handoff, 'release-request.json'))).toBe(false);
  expect(fs.existsSync(path.join(handoff, 'release-request.json.sha256'))).toBe(false);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

});
