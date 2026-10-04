import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { describe, test, expect } from 'vitest';

import { actionEntrypointArguments } from '../../../tests/support/action-entrypoint';

describe.each(['source', 'dist'] as const)('%s entrypoint', (surface) => {
  const entrypointArgs = actionEntrypointArguments(path.resolve(__dirname, '..'), surface);
const root = path.resolve(__dirname, '..');

// integration_id: ci-annotated-tag-resolver-entrypoint-regression
test('entrypoint fails when the token is missing', () => {
  // Arrange
  const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ci-tag-resolver-')), 'output');
  fs.writeFileSync(output, '', 'utf8');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output, 'INPUT_REPOSITORY': 'owner/repo', 'INPUT_TAG': 'v1.2.3', GITHUB_API_URL: 'https://api.example.test' } as Record<string, string>;
  delete env['INPUT_GITHUB-TOKEN'];
  // Act
  const result = spawnSync(process.execPath, [...entrypointArgs], { cwd: root, env, encoding: 'utf8' });
  // Assert
  expect(result.status).not.toBe(0);
  expect(fs.readFileSync(output, 'utf8')).toBe('');
  fs.rmSync(path.dirname(output), { recursive: true, force: true });
});

// contract_id: contract.ci-annotated-tag-resolver.outputs
// integration_id: ci-annotated-tag-resolver-contract-entrypoint
test('entrypoint resolves an annotated tag to its commit', async () => {
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
  const address = server.address();
  expect(address && typeof address !== 'string').toBeTruthy();
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-tag-resolver-'));
  const output = path.join(outputDirectory, 'output');
  fs.writeFileSync(output, '', 'utf8');
  const env = {
    ...process.env,
    GITHUB_ACTIONS: 'true',
    GITHUB_OUTPUT: output,
    INPUT_REPOSITORY: 'owner/repo',
    INPUT_TAG: 'v1.2.3',
    'INPUT_GITHUB-TOKEN': 'token',
    GITHUB_API_URL: `http://127.0.0.1:${(address as AddressInfo).port}`,
  } as Record<string, string>;
  // Act
  const result = await new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [...entrypointArgs], { cwd: root, env });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stderr }));
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // Assert
  expect(result.status, result.stderr).toBe(0);
  const contents = fs.readFileSync(output, 'utf8');
  expect(contents).toMatch(/tag-object-sha/);
  expect(contents).toMatch(/a{40}/);
  expect(contents).toMatch(/tag-object-type/);
  expect(contents).toMatch(/source-sha/);
  expect(contents).toMatch(/b{40}/);
  fs.rmSync(outputDirectory, { recursive: true, force: true });
});

});
