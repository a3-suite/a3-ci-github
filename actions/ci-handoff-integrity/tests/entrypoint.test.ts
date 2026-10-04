import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, test, expect } from 'vitest';


import { actionEntrypointArguments } from '../../../tests/support/action-entrypoint';

describe.each(['source', 'dist'] as const)('%s entrypoint', (surface) => {
  const entrypointArgs = actionEntrypointArguments(path.resolve(__dirname, '..'), surface);
const root = path.resolve(__dirname, '..');
const createHandoff = () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-handoff-integrity-'));
  const body = 'payload';
  fs.writeFileSync(path.join(tempRoot, 'artifact.bin'), body);
  const digest = crypto.createHash('sha256').update(body).digest('hex');
  fs.writeFileSync(path.join(tempRoot, 'manifest.json'), JSON.stringify([{ path: 'artifact.bin', sha256: digest }]));
  fs.writeFileSync(path.join(tempRoot, 'handoff.json'), JSON.stringify({ schema: 'ci.handoff.v1', source_sha: 'source', version: '1.0.0', target_identity: 'linux', manifest: 'manifest.json' }));
  return tempRoot;
};
const runBundled = (handoffRoot: string, sourceSha: string) => {
  const output = path.join(handoffRoot, 'outputs');
  fs.writeFileSync(output, '', 'utf8');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output } as Record<string, string>;
  env['INPUT_HANDOFF-ROOT'] = handoffRoot;
  env['INPUT_DESCRIPTOR'] = 'handoff.json';
  env['INPUT_SOURCE-SHA'] = sourceSha;
  env['INPUT_VERSION'] = '1.0.0';
  env['INPUT_TARGET-IDENTITY'] = 'linux';
  return { output, result: spawnSync(process.execPath, [...entrypointArgs], { cwd: root, env, encoding: 'utf8' }) };
};

// contract_id: contract.ci-handoff-integrity.outputs
// integration_id: ci-handoff-integrity-contract-entrypoint
test('entrypoint validates a handoff', () => {
  // Arrange
  const handoffRoot = createHandoff();
  const manifestDigest = crypto.createHash('sha256').update(fs.readFileSync(path.join(handoffRoot, 'manifest.json'))).digest('hex');
  // Act
  const run = runBundled(handoffRoot, 'source');
  // Assert
  expect(run.result.status).toBe(0);
  const outputs = fs.readFileSync(run.output, 'utf8');
  for (const [key, value] of Object.entries({ status: 'success', descriptor: 'handoff.json', manifest: 'manifest.json', 'manifest-digest': manifestDigest, entries: '1' })) {
    expect(outputs.match(new RegExp(`^${key}<<([^\\n]+)\\n([^\\n]+)\\n\\1$`, 'm'))?.[2]).toBe(value);
  }
  fs.rmSync(handoffRoot, { recursive: true, force: true });
});

// integration_id: ci-handoff-integrity-entrypoint-regression
test('entrypoint fails an identity mismatch', () => {
  // Arrange
  const handoffRoot = createHandoff();
  // Act
  const run = runBundled(handoffRoot, 'other');
  // Assert
  expect(run.result.status).not.toBe(0);
  const outputs = fs.readFileSync(run.output, 'utf8');
  expect(outputs.match(/^status<<([^\n]+)\n([^\n]+)\n\1$/m)?.[2]).toBe('failed');
  expect(outputs).not.toMatch(/^(descriptor|manifest|manifest-digest|entries)<</m);
  fs.rmSync(handoffRoot, { recursive: true, force: true });
});

});
