import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
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
// integration_id: release-assembly-entrypoint
test('assembly bundle emits bound outputs only on complete success', (t) => {
  const f = fixture(t);
  const output = f.put('github-output', '');
  const result = spawnSync(process.execPath, [...bundle], { env: environment(f.options, output), encoding: 'utf8', cwd: f.root });
  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(output, 'utf8'), /status=success\nrelease-handoff=/);
  assert.match(fs.readFileSync(output, 'utf8'), /asset-digest=[a-f0-9]{64}\n/);
  assert.equal(fs.existsSync(path.join(f.options.outputRoot, 'handoff.json')), true);
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
  assert.equal(result.status, 1);
  assert.equal(fs.readFileSync(output, 'utf8'), '');
  assert.equal(fs.existsSync(f.options.outputRoot), false);
  assert.match(result.stderr, /input-invalid:output-directory/);
});

// contract_id: contract.ci-release-assembly.outputs
// integration_id: release-assembly-entrypoint-rejection
test('assembly bundle rejects invalid input without successful outputs', (t) => {
  const f = fixture(t);
  const output = f.put('github-output', '');
  const result = spawnSync(process.execPath, [...bundle], { env: { ...environment(f.options, output), INPUT_REPOSITORY: 'other/repository' }, encoding: 'utf8', cwd: f.root });
  assert.equal(result.status, 1);
  assert.equal(fs.readFileSync(output, 'utf8'), '');
  assert.match(result.stderr, /authority-handoff-binding-mismatch/);
});

});
