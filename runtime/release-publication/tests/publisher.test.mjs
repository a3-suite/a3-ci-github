import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { fixture, remoteClient } from './fixtures.mjs';
import { publishRelease, GithubPublisherClient } from '../../../actions/ci-release-publisher/src/publisher.ts';
import { observeBefore, verifyAfter } from '../observation.ts';

const setup = async (t, changes = {}) => {
  const f = fixture(t);
  const assembly = f.assemble();
  const beforeClient = remoteClient(f, assembly, { ids: [] }).client;
  const options = { authorityPath: f.options.authorityPath, repository: f.identity.repository, handoffRoot: f.options.outputRoot };
  const before = await observeBefore(options, beforeClient);
  const beforePath = f.put('before.json', before);
  f.put('release-notes.json', { schema: 'ci.release-notes.v1', source_contract: 'git.release-flow', source_field: 'body', release_identity: f.identity.tag, body: 'approved notes', body_sha256: f.identity.body_sha256 });
  f.put('release-notes-approval.json', { schema: 'ci.release-notes-approval.v1', source_contract: 'git.release-flow', source_field: 'body', release_identity: f.identity.tag, body_sha256: f.identity.body_sha256, approval_id: 'approved-1' });
  f.put('publication-request.json', { approvalId: 'approved-1', approvalExpiresAt: '2099-01-01T00:00:00Z', releaseIdentity: f.identity.tag, releaseNotesBodySha256: f.identity.body_sha256 });
  const writes = [];
  let created = false;
  const after = remoteClient(f, assembly).client;
  const client = {
    ...beforeClient,
    async json(endpoint) {
      if (endpoint.endsWith('/commits/main')) return { sha: f.identity.source_sha };
      if (endpoint === '/repos/owner/project') return { full_name: f.identity.repository, permissions: { push: true }, default_branch: 'main' };
      return (created ? after : beforeClient).json(endpoint);
    },
    async list(endpoint) { return (created ? after : beforeClient).list(endpoint); },
    async assetDigest(endpoint, size) { return after.assetDigest(endpoint, size); },
    async create(identity, body) { writes.push(['create', identity, body]); created = true; return { id: '42', tag_name: identity.tag, draft: true, body }; },
    async upload(identity, id, asset, filename) { writes.push(['upload', id, asset.name]); assert.equal(fs.statSync(filename).size, asset.size); return { id: '100', name: asset.name, size: asset.size, state: 'uploaded' }; },
    async finalize(identity, id) { writes.push(['finalize', id]); return { id, tag_name: identity.tag, draft: false, body: 'approved notes' }; },
    ...changes,
  };
  return { f, assembly, writes, client, options: { ...options, beforePath, outputRoot: path.join(f.root, 'write') } };
};

// contract_id: contract.ci-release-publisher.outputs
// integration_id: release-publisher-source-flow

test('publisher creates once and emits evidence accepted by independent verifier', async (t) => {
  const { f, writes, client, options } = await setup(t);
  const result = await publishRelease(options, client);
  assert.equal(result.receipt.release_id, '42');
  assert.equal(writes.filter(([op]) => op === 'create').length, 1);
  assert.ok(writes.filter(([op]) => op !== 'create').every(([, id]) => id === '42'));
  assert.deepEqual(fs.readdirSync(options.outputRoot).sort(), ['readback.json', 'receipt.json']);
  const independent = remoteClient(f, JSON.parse(fs.readFileSync(path.join(options.handoffRoot, 'assembly.json')))).client;
  const verified = await verifyAfter({ ...options, receiptPath: result.receiptPath, readbackPath: result.readbackPath }, independent);
  assert.deepEqual(verified.receipt, result.receipt);
});

test('publisher rejects invalid approval, handoff and pre-observation before writes', async (t) => {
  for (const mutation of [
    ({ f }) => f.put('publication-request.json', { approvalId: 'approved-1', approvalExpiresAt: '2000-01-01T00:00:00Z', releaseIdentity: f.identity.tag, releaseNotesBodySha256: f.identity.body_sha256 }),
    ({ f }) => f.put('release-notes.json', { body: 'unapproved' }),
    ({ f }) => f.put('publication-request.json', { schema: 'ci.release-publication-request.v2', approvalId: 'approved-1', approvalExpiresAt: '2099-01-01T00:00:00Z', releaseIdentity: f.identity.tag, releaseNotesBodySha256: f.identity.body_sha256, releaseVersion: f.identity.version, targetIdentity: 'different-target' }),
    ({ f, options }) => f.put('before.json', { ...JSON.parse(fs.readFileSync(options.beforePath)), handoff_digest: 'f'.repeat(64) }),
    ({ f }) => f.put(`handoff/assets/${f.name}`, 'changed'),
  ]) {
    const state = await setup(t);
    mutation(state);
    await assert.rejects(publishRelease(state.options, state.client));
    assert.equal(state.writes.length, 0);
    assert.equal(fs.existsSync(state.options.outputRoot), false);
  }
});

test('publisher rejects moved source, existing draft and unsupported provider before create', async (t) => {
  for (const kind of ['source', 'existing', 'permission', 'permission-missing', 'workflow', 'truncated']) {
    const state = await setup(t);
    const original = state.client.json;
    if (kind === 'existing') state.client.list = async () => [{ id: '9', tag_name: state.f.identity.tag, draft: true }];
    else state.client.json = async (endpoint) => {
      if (kind === 'source' && endpoint.includes('/git/tags/')) return { sha: state.f.identity.tag_object_sha, object: { type: 'commit', sha: 'f'.repeat(40) } };
      if (kind === 'permission-missing' && endpoint === '/repos/owner/project') return { full_name: 'owner/project', default_branch: 'main' };
      if (kind === 'permission' && endpoint === '/repos/owner/project') return { full_name: 'owner/project', permissions: { push: false }, default_branch: 'main' };
      if (['workflow', 'truncated'].includes(kind) && endpoint.endsWith('/commits/main')) return { sha: 'f'.repeat(40) };
      if (['workflow', 'truncated'].includes(kind) && endpoint.includes('/git/commits/')) return { sha: endpoint.split('/').at(-1), tree: { sha: endpoint.split('/').at(-1) } };
      if (['workflow', 'truncated'].includes(kind) && endpoint.includes('/git/trees/')) {
        const sha = endpoint.split('/').at(-1).split('?')[0];
        return { sha, truncated: kind === 'truncated', tree: [{ path: '.github/workflows/release.yml', type: 'blob', mode: '100644', sha }] };
      }
      return original(endpoint);
    };
    await assert.rejects(publishRelease(state.options, state.client));
    assert.equal(state.writes.length, 0);
  }
});

test('publisher supports differing source commits only when complete workflow trees agree', async (t) => {
  const state = await setup(t);
  const original = state.client.json;
  state.client.json = async (endpoint) => {
    if (endpoint.endsWith('/commits/main')) return { sha: 'f'.repeat(40) };
    if (endpoint.includes('/git/commits/')) return { sha: endpoint.split('/').at(-1), tree: { sha: endpoint.split('/').at(-1) } };
    if (endpoint.includes('/git/trees/')) return { sha: endpoint.split('/').at(-1).split('?')[0], truncated: false,
      tree: [{ path: '.github/workflows/release.yml', type: 'blob', mode: '100644', sha: 'e'.repeat(40) }] };
    return original(endpoint);
  };
  const result = await publishRelease(state.options, state.client);
  assert.equal(result.receipt.release_id, '42');
});

test('publisher does not retry or recover failed create upload finalize and readback', async (t) => {
  for (const phase of ['create', 'upload', 'finalize', 'readback']) {
    const state = await setup(t);
    let failures = 0;
    const method = phase === 'readback' ? 'assetDigest' : phase;
    state.client[method] = async () => { failures += 1; throw new Error('provider-state-unknown'); };
    await assert.rejects(publishRelease(state.options, state.client));
    assert.equal(failures, 1);
    assert.equal(fs.existsSync(path.join(state.options.outputRoot, 'receipt.json')), false);
    assert.equal(fs.existsSync(path.join(state.options.outputRoot, 'readback.json')), false);
  }
});


test('publisher transport bounds write operations and sanitizes uncertain provider results', async (t) => {
  const state = await setup(t);
  const secret = 'publisher-transport-secret';
  const filename = path.join(state.options.handoffRoot, 'assets', state.f.name);
  const asset = state.assembly.assets[0];
  const operations = [
    ['release-create', 'POST', (client) => client.create(state.f.identity, 'approved notes')],
    ['asset-upload', 'POST', (client) => client.upload(state.f.identity, '42', asset, filename)],
    ['release-finalize', 'PATCH', (client) => client.finalize(state.f.identity, '42')],
  ];
  for (const [operation, method, invoke] of operations) {
    for (const result of ['success', 'network', 'http', 'json', 'empty', 'oversized']) {
      let calls = 0;
      const client = new GithubPublisherClient(secret, async (url, init) => {
        calls++;
        assert.equal(init.method, method);
        assert.equal(init.redirect, 'error');
        assert.equal(new URL(url).hostname, operation === 'asset-upload' ? 'uploads.github.com' : 'api.github.com');
        if (operation === 'asset-upload') {
          assert.equal(new URL(url).searchParams.get('name'), asset.name);
          assert.equal(init.headers['content-length'], String(asset.size));
        }
        if (result === 'network') throw new Error(secret);
        const status = result === 'http' ? 502 : method === 'POST' ? 201 : 200;
        return new Response(result === 'empty' ? null : result === 'oversized' ? 'x'.repeat(4 * 1024 * 1024 + 1)
          : result === 'success' ? '{"id":42}' : secret, { status, headers: { 'x-github-request-id': 'safe:123' } });
      });
      if (result === 'success') assert.deepEqual(await invoke(client), { id: 42 });
      else await assert.rejects(invoke(client), (error) => {
        assert.ok(!error.message.includes(secret));
        assert.ok(error.message.startsWith('remote-state-unknown:'));
        const diagnostic = JSON.parse(error.message.slice('remote-state-unknown:'.length));
        assert.equal(diagnostic.operation, operation);
        assert.equal(diagnostic.method, method);
        assert.ok(!diagnostic['sanitized-endpoint'].includes('?'));
        assert.equal(diagnostic['http-status'], result === 'network' ? 'unavailable' : result === 'http' ? 502 : method === 'POST' ? 201 : 200);
        assert.equal(diagnostic['request-id'], result === 'network' ? 'unavailable' : 'safe:123');
        return true;
      });
      assert.equal(calls, 1);
    }
  }
});
