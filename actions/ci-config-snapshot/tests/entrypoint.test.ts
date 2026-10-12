import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, test, expect, onTestFinished } from 'vitest';


import { actionEntrypointArguments } from '../../../tests/support/action-entrypoint';

describe.each(['source', 'dist'] as const)('%s entrypoint', (surface) => {
  const entrypointArgs = actionEntrypointArguments(path.resolve(__dirname, '..'), surface);
const root = path.resolve(__dirname, '..');
const runBundled = (snapshotPath: string, outputPath: string, sources: unknown, commandOutputPath = outputPath) => {
  fs.writeFileSync(outputPath, '', 'utf8');
  fs.writeFileSync(commandOutputPath, '', 'utf8');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: commandOutputPath } as Record<string, string>;
  env['INPUT_SOURCES-JSON'] = JSON.stringify(sources);
  env['INPUT_SNAPSHOT-PATH'] = snapshotPath;
  env['INPUT_OUTPUT-PATH'] = outputPath;
  return { output: commandOutputPath, result: spawnSync(process.execPath, [...entrypointArgs], { cwd: root, env, encoding: 'utf8' }) };
};

// contract_id: contract.ci-config-snapshot.outputs
// integration_id: ci-config-snapshot-contract-entrypoint
test('entrypoint writes snapshot and outputs', () => {
  // Arrange
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-config-snapshot-'));
  const snapshot = path.join(tempRoot, 'snapshot.json');
  const output = path.join(tempRoot, 'outputs');
  const sources = { MODE: 'runtime' };
  const values = { MODE: 'dry-run' };
  const digest = crypto.createHash('sha256').update(JSON.stringify({ sources, values })).digest('hex');
  // Act
  const run = runBundled(snapshot, output, { preset: { MODE: 'release' }, runtime: { MODE: 'dry-run' } });
  // Assert
  expect(run.result.status).toBe(0);
  expect(JSON.parse(fs.readFileSync(snapshot, 'utf8'))).toStrictEqual({ schema: 'ci.config-snapshot.v1', values, sources, digest });
  const outputs = fs.readFileSync(output, 'utf8');
  for (const [key, value] of Object.entries({ status: 'success', 'snapshot-path': snapshot, digest })) {
    expect(outputs.match(new RegExp(`^${key}<<([^\\n]+)\\n([^\\n]+)\\n\\1$`, 'm'))?.[2]).toBe(value);
  }
  expect(outputs.match(/^config_snapshot_path=(.*)$/m)?.[1]).toBe(snapshot);
  expect(outputs.match(/^config_snapshot_digest=(.*)$/m)?.[1]).toBe(digest);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

// contract_id: contract.ci-config-snapshot.outputs
// integration_id: ci-config-snapshot-entrypoint-regression
test('retains saved snapshot evidence when GITHUB_OUTPUT fails', () => {
  // Arrange
  fs.mkdirSync(path.resolve('tests/tmp'), { recursive: true });
  const fixture = fs.mkdtempSync(path.resolve('tests/tmp/snapshot-output-failure-'));
  onTestFinished(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const snapshot = path.join(fixture, 'snapshot.json');
  const sentinel = path.join(fixture, 'existing-state');
  fs.writeFileSync(sentinel, 'unchanged');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('INPUT_')));
  Object.assign(env, {
    GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: fixture,
    'INPUT_SOURCES-JSON': JSON.stringify({ runtime: { MODE: 'private-valid-value' } }),
    'INPUT_SNAPSHOT-PATH': snapshot,
  });
  // Act
  const result = spawnSync(process.execPath, entrypointArgs, { cwd: root, env, encoding: 'utf8' });
  // Assert
  expect(result.status).toBe(1);
  const saved = JSON.parse(fs.readFileSync(snapshot, 'utf8'));
  expect(saved.values).toStrictEqual({ MODE: 'private-valid-value' });
  expect(saved.digest).toBe(crypto.createHash('sha256').update(JSON.stringify({ sources: saved.sources, values: saved.values })).digest('hex'));
  const line = result.stderr.split('\n').find((value) => value.startsWith('ci-failure-diagnostic:'));
  const evidence = JSON.parse(line?.slice('ci-failure-diagnostic:'.length) ?? '{}');
  expect(evidence.classification).toMatchObject({ stage: 'output-write', reason: 'filesystem-eisdir' });
  expect(evidence['evidence-location'].file).toBe('configured-snapshot-path');
  expect(evidence['execution-state']).toMatchObject({ lastConfirmed: 'snapshot-write', retention: 'log-and-file' });
  expect(fs.readFileSync(sentinel, 'utf8')).toBe('unchanged');
  expect(result.stdout + result.stderr).not.toContain(fixture);
  expect(result.stdout + result.stderr).not.toContain('private-valid-value');
});

// integration_id: ci-config-snapshot-entrypoint-regression
test('entrypoint rejects snapshot and output collisions', () => {
  // Arrange
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-config-snapshot-'));
  const snapshot = path.join(tempRoot, 'snapshot.json');
  // Act
  const run = runBundled(snapshot, snapshot, { preset: { MODE: 'release' } });
  // Assert
  expect(run.result.status).not.toBe(0);
  expect(fs.readFileSync(run.output, 'utf8')).toMatch(/status<</);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

// integration_id: ci-config-snapshot-entrypoint-regression
test('entrypoint rejects a snapshot colliding with GITHUB_OUTPUT', () => {
  // Arrange
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-config-snapshot-'));
  const snapshot = path.join(tempRoot, 'snapshot.json');
  const explicitOutput = path.join(tempRoot, 'explicit-output');
  // Act
  const run = runBundled(snapshot, explicitOutput, { preset: { MODE: 'release' } }, snapshot);
  // Assert
  expect(run.result.status).not.toBe(0);
  const outputs = fs.readFileSync(run.output, 'utf8');
  expect(outputs.match(/^status<<([^\n]+)\n([^\n]+)\n\1$/m)?.[2]).toBe('failed');
  expect(outputs).not.toMatch(/^(snapshot-path|digest)<<|^config_snapshot_(path|digest)=/m);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

});
