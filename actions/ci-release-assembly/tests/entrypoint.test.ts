import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { describe, test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fixture } from '../../../runtime/release-publication/tests/fixtures.mjs';

import { actionEntrypointArguments } from '../../../tests/support/action-entrypoint';

describe.each(['source', 'dist'] as const)('%s entrypoint', (surface) => {
  const entrypointArgs = actionEntrypointArguments(path.resolve(__dirname, '..'), surface);
const bundle = entrypointArgs;
const environment = (options: Record<string, string>, output: string): NodeJS.ProcessEnv => ({
  ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output,
  INPUT_REPOSITORY: options.repository, 'INPUT_AUTHORITY-PATH': options.authorityPath,
  'INPUT_SNAPSHOT-PATH': options.snapshotPath, 'INPUT_PLATFORM-MANIFEST-PATH': options.platformManifestPath,
  'INPUT_PLATFORM-MATRIX': options.platformMatrix, 'INPUT_BUILD-ROOT': options.buildRoot,
  'INPUT_OUTPUT-DIRECTORY': options.outputRoot,
});

// contract_id: contract.ci-release-assembly.outputs
// integration_id: release-assembly-detailed-failure
test('missing build inventory retains the failing stage and exact missing entries', (t) => {
  const f = fixture(t);
  const output = f.put('github-output', '');
  fs.renameSync(path.join(f.options.buildRoot, 'release-build-linux'), path.join(f.root, 'saved-build'));
  const result = spawnSync(process.execPath, [...bundle], { env: environment(f.options, output), encoding: 'utf8', cwd: f.root });
  const line = result.stderr.split('\n').find((value) => value.startsWith('ci-failure-diagnostic:'));
  const evidence = JSON.parse(line?.slice('ci-failure-diagnostic:'.length) ?? '{}');
  expect(result.status).toBe(1);
  expect(evidence.classification).toMatchObject({ subject: 'ci-release-assembly', stage: 'build-inventory', reason: 'asset-set-mismatch' });
  expect(evidence.comparison).toMatchObject({ field: 'build-directories', missing: ['release-build-linux'], extra: [] });
  expect(evidence['execution-state']).toMatchObject({ outcome: 'failure', write: 'not-started' });
  expect(fs.readFileSync(output, 'utf8')).toBe('');
  expect(fs.existsSync(f.options.outputRoot)).toBe(false);
});

// contract_id: contract.ci-release-assembly.outputs
// integration_id: release-assembly-entrypoint
test('assembly bundle emits bound outputs only on complete success', (t) => {
  const f = fixture(t);
  const output = f.put('github-output', '');
  const payload = Buffer.from('verified archive bytes');
  const payloadDigest = crypto.createHash('sha256').update(payload).digest('hex');
  const checksum = Buffer.from(`${payloadDigest}  project-1.0.0-linux.tar.gz\n`);
  const assets = [
    { name: 'project-1.0.0-linux.tar.gz', sha256: payloadDigest, size: payload.length },
    { name: 'project-1.0.0-linux.tar.gz.sha256', sha256: crypto.createHash('sha256').update(checksum).digest('hex'), size: checksum.length },
  ];
  const digest = crypto.createHash('sha256').update(JSON.stringify(assets)).digest('hex');
  const result = spawnSync(process.execPath, [...bundle], { env: environment(f.options, output), encoding: 'utf8', cwd: f.root });
  expect(result.status, result.stderr).toBe(0);
  expect(fs.readFileSync(output, 'utf8')).toBe(`status=success\nrelease-handoff=${f.options.outputRoot}\nasset-digest=${digest}\n`);
  const assembly = JSON.parse(fs.readFileSync(path.join(f.options.outputRoot, 'assembly.json'), 'utf8'));
  expect(assembly.assets).toStrictEqual(assets);
  expect(assembly.asset_digest).toBe(digest);
  expect(fs.existsSync(path.join(f.options.outputRoot, 'handoff.json'))).toBe(true);
});

// contract_id: contract.ci-release-assembly.outputs
// integration_id: release-assembly-output-injection-rejection
test('assembly bundle rejects output path line injection before assembly', (t) => {
  const f = fixture(t);
  const output = f.put('github-output', '');
  const result = spawnSync(process.execPath, [...bundle], {
    env: { ...environment(f.options, output), 'INPUT_OUTPUT-DIRECTORY': `${f.options.outputRoot}\nstatus=success` },
    encoding: 'utf8', cwd: f.root,
  });
  expect(result.status).toBe(1);
  expect(fs.readFileSync(output, 'utf8')).toBe('');
  expect(fs.existsSync(f.options.outputRoot)).toBe(false);
  expect(result.stderr).toMatch(/input-invalid:output-directory/);
});

// contract_id: contract.ci-release-assembly.outputs
// integration_id: release-assembly-entrypoint-rejection
test('assembly bundle rejects invalid input without successful outputs', (t) => {
  const f = fixture(t);
  const output = f.put('github-output', '');
  const result = spawnSync(process.execPath, [...bundle], { env: { ...environment(f.options, output), INPUT_REPOSITORY: 'other/repository' }, encoding: 'utf8', cwd: f.root });
  expect(result.status).toBe(1);
  expect(fs.readFileSync(output, 'utf8')).toBe('');
  expect(result.stderr).toMatch(/authority-handoff-binding-mismatch/);
});

});
