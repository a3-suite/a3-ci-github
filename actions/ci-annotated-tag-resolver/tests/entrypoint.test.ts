import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { describe, test, expect, onTestFinished } from 'vitest';

import { actionEntrypointArguments } from '../../../tests/support/action-entrypoint';

const runEntrypoint = (args: string[], cwd: string, env: NodeJS.ProcessEnv) =>
  new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stderr }));
  });

describe.each(['source', 'dist'] as const)('%s entrypoint', (surface) => {
  const entrypointArgs = actionEntrypointArguments(path.resolve(__dirname, '..'), surface);
const root = path.resolve(__dirname, '..');

// flow_id: ci-annotated-tag-resolver-entrypoint-regression
test.each([
  { name: 'the token is missing', key: 'INPUT_GITHUB-TOKEN', value: '' },
  { name: 'the repository is missing', key: 'INPUT_REPOSITORY', value: '' },
  { name: 'the repository is malformed', key: 'INPUT_REPOSITORY', value: 'owner-only' },
  { name: 'the tag is missing', key: 'INPUT_TAG', value: '' },
])('entrypoint fails when $name', ({ key, value }) => {
  // Arrange
  const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ci-tag-resolver-')), 'output');
  fs.writeFileSync(output, '', 'utf8');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output, 'INPUT_REPOSITORY': 'owner/repo', 'INPUT_TAG': 'v1.2.3', GITHUB_API_URL: 'https://api.example.test' } as Record<string, string>;
  env['INPUT_GITHUB-TOKEN'] = 'test-token';
  env[key] = value;
  onTestFinished(() => fs.rmSync(path.dirname(output), { recursive: true, force: true }));
  // Act
  const result = spawnSync(process.execPath, [...entrypointArgs], { cwd: root, env, encoding: 'utf8' });
  // Assert
  expect(result.status).not.toBe(0);
  const diagnosticStage = value === '' ? 'tag-resolution' : 'input-validation';
  expect(result.stderr).toMatch(new RegExp(`^ci-failure-diagnostic:.*"stage":"${diagnosticStage}"`, 'm'));
  expect(fs.readFileSync(output, 'utf8')).toBe('');
});

// contract_id: contract.ci-annotated-tag-resolver.outputs
// flow_id: ci-annotated-tag-resolver-contract-entrypoint
test('entrypoint resolves an annotated tag and diagnoses output write failure', async (t) => {
  // Arrange
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url?.endsWith('/git/ref/tags/v1.2.3')) {
      response.end(JSON.stringify({ object: { type: 'tag', sha: 'a'.repeat(40) } }));
      return;
    }
    if (request.url?.endsWith(`/git/tags/${'a'.repeat(40)}`)) {
      response.end(JSON.stringify({ object: { type: 'commit', sha: 'b'.repeat(40) } }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ message: 'not-found' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  expect(address && typeof address !== 'string').toBeTruthy();
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-tag-resolver-'));
  t.onTestFinished(() => fs.rmSync(outputDirectory, { recursive: true, force: true }));
  const output = path.join(outputDirectory, 'output');
  fs.writeFileSync(output, '', 'utf8');
  const env = {
    ...process.env,
    GITHUB_ACTIONS: 'true',
    GITHUB_OUTPUT: output,
    INPUT_REPOSITORY: 'owner/repo',
    INPUT_TAG: 'v1.2.3',
    'INPUT_GITHUB-TOKEN': 'test-token',
    GITHUB_API_URL: `http://127.0.0.1:${(address as AddressInfo).port}`,
  } as Record<string, string>;
  // Act
  const result = await runEntrypoint([...entrypointArgs], root, env);
  const unwritable = await runEntrypoint([...entrypointArgs], root, { ...env, GITHUB_OUTPUT: outputDirectory });
  // Assert
  expect(result.status, result.stderr).toBe(0);
  const contents = fs.readFileSync(output, 'utf8');
  expect(contents).toMatch(/^tag-object-sha<<([^\r\n]+)\r?\na{40}\r?\n\1$/m);
  expect(contents).toMatch(/^tag-object-type<<([^\r\n]+)\r?\ntag\r?\n\1$/m);
  expect(contents).toMatch(/^source-sha<<([^\r\n]+)\r?\nb{40}\r?\n\1$/m);
  expect(unwritable.status).toBe(1);
  expect(unwritable.stderr).toMatch(/^ci-failure-diagnostic:.*"stage":"output-write"/m);
});

// contract_id: contract.ci-annotated-tag-resolver.outputs
test.each([
  { name: 'provider rejection', status: 404, payload: { message: 'not-found' }, stage: 'tag-ref-observation', reason: 'github-api-http-404' },
  { name: 'lightweight tag', status: 200, payload: { object: { type: 'commit', sha: 'a'.repeat(40) } }, stage: 'annotated-tag-validation', reason: 'annotated-tag-required' },
  { name: 'invalid tag SHA', status: 200, payload: { object: { type: 'tag', sha: 'invalid' } }, stage: 'annotated-tag-validation', reason: 'tag-sha-invalid' },
  { name: 'non-commit target', status: 200, payload: { object: { type: 'tree', sha: 'b'.repeat(40) } }, stage: 'commit-resolution', reason: 'tag-dereference-to-commit-required' },
])('entrypoint diagnoses $name', async ({ status, payload, stage, reason }) => {
  const server = http.createServer((request, response) => {
    if (stage === 'commit-resolution' && request.url?.endsWith('/git/ref/tags/v1.2.3')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ object: { type: 'tag', sha: 'a'.repeat(40) } }));
      return;
    }
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-tag-resolver-'));
  onTestFinished(() => fs.rmSync(outputDirectory, { recursive: true, force: true }));
  const output = path.join(outputDirectory, 'output');
  fs.writeFileSync(output, '');

  const result = await runEntrypoint([...entrypointArgs], root, {
    ...process.env,
    GITHUB_ACTIONS: 'true',
    GITHUB_OUTPUT: output,
    INPUT_REPOSITORY: 'owner/repo',
    INPUT_TAG: 'v1.2.3',
    'INPUT_GITHUB-TOKEN': 'test-token',
    GITHUB_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  });

  expect(result.status).toBe(1);
  const diagnostic = result.stderr.split('\n').find(line => line.startsWith('ci-failure-diagnostic:'));
  expect(diagnostic).toBeDefined();
  expect(JSON.parse(diagnostic!.slice('ci-failure-diagnostic:'.length)).classification).toMatchObject({
    stage,
    reason,
  });
});

});
