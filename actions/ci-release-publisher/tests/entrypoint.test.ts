import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fixture } from '../../../runtime/release-publication/tests/fixtures.mjs';
import { observeBefore } from '../../../runtime/release-publication/observation';
import { remoteClient } from '../../../runtime/release-publication/tests/fixtures.mjs';

import { actionEntrypointArguments } from '../../../tests/support/action-entrypoint';

describe.each(['source', 'dist'] as const)('%s entrypoint', (surface) => {
  const entrypointArgs = actionEntrypointArguments(path.resolve(__dirname, '..'), surface);
const bundle = entrypointArgs;

// contract_id: contract.ci-release-publisher.outputs
// integration_id: release-publisher-bundled-flow
test('publisher entrypoint writes once by immutable ID and emits evidence paths', async (t) => {
  const f = fixture(t);
  const assembly = f.assemble();
  const before = await observeBefore({ authorityPath: f.options.authorityPath, repository: f.identity.repository, handoffRoot: f.options.outputRoot }, remoteClient(f, assembly, { ids: [] }).client);
  const beforePath = f.put('before.json', before);
  f.put('release-notes.json', { schema: 'ci.release-notes.v1', source_contract: 'git.release-flow', source_field: 'body', release_identity: f.identity.tag, body: 'approved notes', body_sha256: f.identity.body_sha256 });
  f.put('release-notes-approval.json', { schema: 'ci.release-notes-approval.v1', source_contract: 'git.release-flow', source_field: 'body', release_identity: f.identity.tag, body_sha256: f.identity.body_sha256, approval_id: 'approved-1' });
  f.put('publication-request.json', { approvalId: 'approved-1', approvalExpiresAt: '2099-01-01T00:00:00Z', releaseIdentity: f.identity.tag, releaseNotesBodySha256: f.identity.body_sha256 });
  const mock = f.put('mock-fetch.mjs', `
import fs from 'node:fs';
import path from 'node:path';
const assembly = JSON.parse(fs.readFileSync(path.join(process.env.MOCK_HANDOFF, 'assembly.json')));
let created = false;
let finalized = false;
let uploaded = 0;
globalThis.fetch = async (url, init) => {
  const u = new URL(String(url));
  const endpoint = u.pathname;
  let data;
  let status = 200;
  if (init.method !== 'GET') fs.appendFileSync(process.env.MOCK_CALLS, JSON.stringify({ method: init.method, endpoint }) + '\\n');
  if (init.method === 'POST' && endpoint.endsWith('/releases')) {
    if (created) throw new Error('create-retry-forbidden');
    const request = JSON.parse(init.body);
    if (request.tag_name !== assembly.identity.tag || request.target_commitish !== assembly.identity.source_sha || request.body !== 'approved notes' || request.draft !== true || request.generate_release_notes !== false) throw new Error('create-payload-invalid');
    created = true; status = 201; data = { id: 42, tag_name: assembly.identity.tag, draft: true, body: request.body };
  } else if (init.method === 'POST') {
    if (endpoint !== '/repos/owner/project/releases/42/assets' || u.hostname !== 'uploads.github.com') throw new Error('upload-id-invalid');
    if (process.env.MOCK_FAILURE === 'upload') return new Response('synthetic-secret', { status: 502 });
    const asset = assembly.assets.find(a => a.name === u.searchParams.get('name'));
    const bytes = Buffer.from(await new Response(init.body).arrayBuffer());
    if (!asset || bytes.length !== asset.size) throw new Error('upload-bytes-invalid');
    status = 201; data = { id: 100 + uploaded++, name: asset.name, size: asset.size, state: 'uploaded' };
  } else if (init.method === 'PATCH') {
    if (endpoint !== '/repos/owner/project/releases/42' || uploaded !== assembly.assets.length) throw new Error('finalize-invalid');
    finalized = true; data = { id: 42, tag_name: assembly.identity.tag, draft: false, body: 'approved notes' };
  } else if (endpoint.includes('/git/ref/tags/')) data = { object: { type: 'tag', sha: assembly.identity.tag_object_sha } };
  else if (endpoint.includes('/git/tags/')) data = { sha: assembly.identity.tag_object_sha, object: { type: 'commit', sha: assembly.identity.source_sha } };
  else if (endpoint.endsWith('/commits/main')) data = { sha: assembly.identity.source_sha };
  else if (endpoint.endsWith('/releases/42/assets')) data = assembly.assets.map((a, i) => ({ id: i + 100, name: a.name, size: a.size, state: 'uploaded' }));
  else if (endpoint.includes('/releases/assets/')) return new Response(fs.readFileSync(path.join(process.env.MOCK_HANDOFF, 'assets', assembly.assets[Number(endpoint.split('/').at(-1)) - 100].name)));
  else if (endpoint.endsWith('/releases/42')) data = { id: 42, tag_name: assembly.identity.tag, draft: !finalized, body: 'approved notes' };
  else if (endpoint.endsWith('/releases')) data = created ? [{ id: 42, tag_name: assembly.identity.tag, draft: !finalized }] : [];
  else data = { full_name: assembly.identity.repository, permissions: { push: true }, default_branch: 'main' };
  return new Response(JSON.stringify(data), { status });
};
`);
  const output = f.put('github-output', '');
  const calls = f.put('calls', '');
  const outputRoot = path.join(f.root, 'write');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: f.identity.repository, GITHUB_OUTPUT: output, GH_TOKEN: 'synthetic-secret',
    'INPUT_AUTHORITY-PATH': f.options.authorityPath, 'INPUT_RELEASE-HANDOFF-ROOT': f.options.outputRoot, 'INPUT_PRE-OBSERVATION-PATH': beforePath,
    'INPUT_WRITE-OUTPUT-DIRECTORY': outputRoot, MOCK_HANDOFF: f.options.outputRoot, MOCK_CALLS: calls };
  const result = spawnSync(process.execPath, ['--import', mock, ...bundle], { env, cwd: f.root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(output, 'utf8'), `receipt-path=${outputRoot}/receipt.json\nreadback-path=${outputRoot}/readback.json\n`);
  const writes = fs.readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { method: string; endpoint: string });
  assert.equal(writes.filter(entry => entry.endpoint.endsWith('/releases')).length, 1);
  assert.ok(writes.slice(1).every(entry => entry.endpoint.includes('/releases/42')));
  assert.equal(JSON.parse(fs.readFileSync(`${outputRoot}/receipt.json`, 'utf8')).release_id, '42');
  assert.equal((result.stdout + result.stderr + fs.readFileSync(output, 'utf8')).includes('synthetic-secret'), false);
  fs.writeFileSync(output, ''); fs.writeFileSync(calls, '');
  const failedRoot = path.join(f.root, 'failed-write');
  const failed = spawnSync(process.execPath, ['--import', mock, ...bundle], { env: { ...env, MOCK_FAILURE: 'upload', 'INPUT_WRITE-OUTPUT-DIRECTORY': failedRoot }, cwd: f.root, encoding: 'utf8' });
  assert.equal(failed.status, 1);
  assert.equal(fs.readFileSync(output, 'utf8'), '');
  assert.equal(fs.existsSync(`${failedRoot}/receipt.json`), false);
  assert.equal(fs.existsSync(`${failedRoot}/readback.json`), false);
  assert.equal(failed.stderr.includes('synthetic-secret'), false);
  assert.match(failed.stderr, /asset-upload/);
});

// contract_id: contract.ci-release-publisher.outputs
// integration_id: release-publisher-bundled-rejection
test('publisher entrypoint rejects missing credential and path injection without outputs', (t) => {
  const f = fixture(t);
  const output = f.put('github-output', '');
  for (const token of ['', 'synthetic-secret']) {
    const result = spawnSync(process.execPath, [...bundle], { env: { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output, GH_TOKEN: token,
      'INPUT_AUTHORITY-PATH': 'bad\npath', 'INPUT_RELEASE-HANDOFF-ROOT': 'handoff', 'INPUT_PRE-OBSERVATION-PATH': 'before.json', 'INPUT_WRITE-OUTPUT-DIRECTORY': 'write', GITHUB_REPOSITORY: 'owner/project' }, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(fs.readFileSync(output, 'utf8'), '');
    assert.equal(result.stderr.includes('synthetic-secret'), false);
  }
});

});
