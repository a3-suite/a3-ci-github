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
const hash = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');

// contract_id: contract.ci-release-publication-verifier.outputs
// integration_id: release-publication-verifier-entrypoint
test('publication entrypoint observes absence then verifies owner evidence independently', (t) => {
  const f = fixture(t);
  f.assemble();
  const assembly = JSON.parse(fs.readFileSync(path.join(f.options.outputRoot, 'assembly.json'), 'utf8'));
  const mock = f.put('mock-fetch.mjs', `
import fs from 'node:fs';
import path from 'node:path';
const assembly = JSON.parse(fs.readFileSync(path.join(process.env.MOCK_HANDOFF, 'assembly.json')));
globalThis.fetch = async (url, init) => {
  if (init.method !== 'GET') throw new Error('write-forbidden');
  const endpoint = new URL(String(url)).pathname;
  let data;
  if (endpoint.includes('/git/ref/tags/')) data = { object: { type: 'tag', sha: assembly.identity.tag_object_sha } };
  else if (endpoint.includes('/git/tags/')) data = { sha: assembly.identity.tag_object_sha, object: { type: 'commit', sha: assembly.identity.source_sha } };
  else if (endpoint.endsWith('/releases/42/assets')) data = assembly.assets.map((asset, index) => ({ id: index + 100, name: asset.name, size: asset.size, state: 'uploaded' }));
  else if (endpoint.includes('/releases/assets/')) return new Response(fs.readFileSync(path.join(process.env.MOCK_HANDOFF, 'assets', assembly.assets[Number(endpoint.split('/').at(-1)) - 100].name)));
  else if (endpoint.endsWith('/releases/42')) data = { id: 42, tag_name: assembly.identity.tag, draft: false, body: 'approved notes' };
  else if (endpoint.endsWith('/releases')) data = process.env.MOCK_PHASE === 'before' ? [] : [{ id: 42, tag_name: assembly.identity.tag, draft: false }];
  else data = { full_name: assembly.identity.repository, permissions: { push: true } };
  return new Response(JSON.stringify(data));
};
`);
  const beforePath = path.join(f.root, 'before.json');
  const output = f.put('github-output', '');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output, GH_TOKEN: 'synthetic-secret', INPUT_OPERATION: 'observe-before', INPUT_REPOSITORY: f.options.repository, 'INPUT_AUTHORITY-PATH': f.options.authorityPath, 'INPUT_HANDOFF-ROOT': f.options.outputRoot, 'INPUT_OBSERVATION-PATH': beforePath, MOCK_HANDOFF: f.options.outputRoot, MOCK_PHASE: 'before' };
  const beforeResult = spawnSync(process.execPath, ['--import', mock, ...bundle], { env, encoding: 'utf8', cwd: f.root });
  expect(beforeResult.status, beforeResult.stderr).toBe(0);
  const beforeOutputs = fs.readFileSync(output, 'utf8');
  expect(beforeOutputs).toMatch(/^status=success\n/);
  expect(beforeOutputs.includes(`observation-path=${beforePath}\n`)).toBeTruthy();
  expect(beforeOutputs.includes(`observation-digest=${hash(fs.readFileSync(beforePath))}\n`)).toBeTruthy();
  expect(beforeOutputs.includes('release-remote-identity=')).toBe(false);
  expect(beforeOutputs.includes('publish-receipt=')).toBe(false);
  expect(beforeOutputs.includes('readback-evidence=')).toBe(false);
  const handoffDigest = hash(fs.readFileSync(path.join(f.options.outputRoot, 'handoff.json')));
  const receipt = { schema_version: '1', kind: 'ci-github-release-publish-receipt', identity: assembly.identity, handoff_digest: handoffDigest, asset_digest: assembly.asset_digest, release_id: '42', pre_observation_sha256: hash(fs.readFileSync(beforePath)) };
  const readback = { schema_version: '1', kind: 'ci-github-release-readback', identity: assembly.identity, handoff_digest: handoffDigest, asset_digest: assembly.asset_digest, release_id: '42', draft: false, assets: assembly.assets, inventory: { ...JSON.parse(fs.readFileSync(beforePath, 'utf8')), phase: 'post-create', release_ids: ['42'] } };
  const receiptPath = f.put('receipt.json', receipt);
  const readbackPath = f.put('readback.json', readback);
  fs.writeFileSync(output, '');
  const afterResult = spawnSync(process.execPath, ['--import', mock, ...bundle], { env: { ...env, INPUT_OPERATION: 'verify-after', 'INPUT_RECEIPT-PATH': receiptPath, 'INPUT_READBACK-PATH': readbackPath, MOCK_PHASE: 'after' }, encoding: 'utf8', cwd: f.root });
  expect(afterResult.status, afterResult.stderr).toBe(0);
  const outputs = fs.readFileSync(output, 'utf8');
  expect(outputs).toMatch(/^status=success\n/);
  expect(outputs.includes('observation-path=')).toBe(false);
  expect(outputs.includes('observation-digest=')).toBe(false);
  expect(outputs).toMatch(/release-remote-identity=42\n/);
  expect(outputs).toMatch(/publish-receipt=\{/);
  expect(outputs).toMatch(/readback-evidence=\{/);
  expect(outputs.includes('synthetic-secret')).toBe(false);
});

// contract_id: contract.ci-release-publication-verifier.outputs
// integration_id: release-publication-output-injection-rejection
test('publication entrypoint rejects output path line injection before remote observation', (t) => {
  const f = fixture(t);
  f.assemble();
  const output = f.put('github-output', '');
  const result = spawnSync(process.execPath, [...bundle], {
    env: {
      ...process.env, GH_TOKEN: 'synthetic-secret', GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output,
      INPUT_OPERATION: 'observe-before', INPUT_REPOSITORY: f.options.repository,
      'INPUT_AUTHORITY-PATH': f.options.authorityPath, 'INPUT_HANDOFF-ROOT': f.options.outputRoot,
      'INPUT_OBSERVATION-PATH': `${path.join(f.root, 'before.json')}\nstatus=success`,
    }, encoding: 'utf8', cwd: f.root,
  });
  expect(result.status).toBe(1);
  expect(fs.readFileSync(output, 'utf8')).toBe('');
  expect(fs.existsSync(path.join(f.root, 'before.json'))).toBe(false);
  expect(result.stderr).toMatch(/input-invalid:observation-path/);
});

// contract_id: contract.ci-release-publication-verifier.outputs
// integration_id: release-publication-verifier-entrypoint-rejection
test('publication entrypoint refuses missing credentials without success evidence', (t) => {
  const f = fixture(t);
  f.assemble();
  const output = f.put('github-output', '');
  const result = spawnSync(process.execPath, [...bundle], { env: { ...process.env, GH_TOKEN: '', GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output, INPUT_OPERATION: 'observe-before', INPUT_REPOSITORY: f.options.repository, 'INPUT_AUTHORITY-PATH': f.options.authorityPath, 'INPUT_HANDOFF-ROOT': f.options.outputRoot, 'INPUT_OBSERVATION-PATH': path.join(f.root, 'before.json') }, encoding: 'utf8', cwd: f.root });
  expect(result.status).toBe(1);
  expect(fs.readFileSync(output, 'utf8')).toBe('');
  expect(result.stderr).toMatch(/credential-missing/);
});

});
