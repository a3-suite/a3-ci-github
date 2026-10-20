import fs from 'node:fs';
import path from 'node:path';
import { test, describe, expect } from 'vitest';
import { holdProcessOutput } from '../../../tests/support/hold-process-output.mjs';
import { fixture, remoteClient, preObservationFixture } from './fixtures.mjs';
import { publishRelease, GithubPublisherClient } from '../../../actions/ci-release-publisher/src/publisher.ts';
import { loadAssembly, observeBefore, verifyAfter } from '../observation.ts';

const setup = async (t, changes = {}, { realObservation = false } = {}) => {
  const f = fixture(t);
  const assembly = f.assemble();
  const beforeClient = remoteClient(f, assembly, { ids: [] }).client;
  const options = { authorityPath: f.options.authorityPath, repository: f.identity.repository, handoffRoot: f.options.outputRoot };
  const before = realObservation ? await observeBefore(options, beforeClient) : preObservationFixture(options);
  const beforePath = f.put('before.json', before);
  f.put('release-notes.json', { schema: 'ci.release-notes.v1', source_contract: 'git.release-flow', source_field: 'body', release_identity: f.identity.tag, body: 'approved notes', body_sha256: f.identity.body_sha256 });
  f.put('release-notes-approval.json', { schema: 'ci.release-notes-approval.v1', source_contract: 'git.release-flow', source_field: 'body', release_identity: f.identity.tag, body_sha256: f.identity.body_sha256, approval_id: 'approved-1' });
  f.put('publication-request.json', { schema: 'ci.release-publication-request.v2', releaseVersion: f.identity.version, targetIdentity: f.identity.target_identity, approvalId: 'approved-1', approvalExpiresAt: '2099-01-01T00:00:00Z', releaseIdentity: f.identity.tag, releaseNotesBodySha256: f.identity.body_sha256 });
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
    async upload(identity, id, asset, filename) { writes.push(['upload', id, asset.name]); expect(fs.statSync(filename).size).toBe(asset.size); return { id: '100', name: asset.name, size: asset.size, state: 'uploaded' }; },
    async finalize(identity, id) { writes.push(['finalize', id]); return { id, tag_name: identity.tag, draft: false, body: 'approved notes' }; },
    ...changes,
  };
  // Record prohibited operations even if the publisher catches their rejection.
  for (const operation of ['delete', 'remove', 'replace', 'recover']) {
    client[operation] = async (...args) => { writes.push([operation, ...args]); throw new Error('unexpected-recovery-write'); };
  }
  return { f, assembly, writes, client, options: { ...options, beforePath, outputRoot: path.join(f.root, 'write') } };
};

holdProcessOutput('stdout');

describe("contract.ci-release-publisher.outputs", () => {
  describe("release-publisher-source-flow", { concurrent: true }, () => {
    // contract_id: contract.ci-release-publisher.outputs
    // integration_id: release-publisher-source-flow

    // contract_id: contract.ci-release-publisher.outputs
    // integration_id: release-publisher-source-flow
    test('bound standard capability permits false API push through publication and independent readback', async (t) => {
      // Arrange
      const { f, writes, client, options } = await setup(t);
      const original = client.json;
      client.hasStandardGithubTokenWriteAccess = repository => repository === f.identity.repository;
      client.json = async endpoint => endpoint === '/repos/owner/project'
        ? { full_name: f.identity.repository, permissions: { push: false }, default_branch: 'main' } : original(endpoint);
      // Act
      const result = await publishRelease(options, client);
      const verified = await verifyAfter({ ...options, receiptPath: result.receiptPath, readbackPath: result.readbackPath }, client);
      // Assert
      expect(writes.filter(([operation]) => operation === 'create')).toHaveLength(1);
      expect(writes.some(([operation]) => operation === 'upload')).toBe(true);
      expect(writes.filter(([operation]) => operation === 'finalize')).toHaveLength(1);
      expect(verified.receipt.release_id).toBe('42');
    });
    test('publisher creates once and emits evidence accepted by independent verifier', async (t) => {
      const { f, writes, client, options } = await setup(t, {}, { realObservation: true });
      const result = await publishRelease(options, client);
      expect(result.receipt.release_id).toBe('42');
      expect(writes.filter(([op]) => op === 'create').length).toBe(1);
      expect(writes.filter(([op]) => op !== 'create').every(([, id]) => id === '42')).toBeTruthy();
      expect(fs.readdirSync(options.outputRoot).sort()).toStrictEqual(['readback.json', 'receipt.json']);
      const independent = remoteClient(f, JSON.parse(fs.readFileSync(path.join(options.handoffRoot, 'assembly.json')))).client;
      const verified = await verifyAfter({ ...options, receiptPath: result.receiptPath, readbackPath: result.readbackPath }, independent);
      expect(verified.receipt).toStrictEqual(result.receipt);
    });

    test('publisher preserves approved identity across canonical repository casing', async (t) => {
      const state = await setup(t);
      const json = state.client.json;
      state.client.json = async (endpoint) => {
        const value = await json(endpoint);
        return endpoint === '/repos/owner/project' ? { ...value, full_name: 'Owner/Project' } : value;
      };
      const result = await publishRelease(state.options, state.client);
      expect(result.receipt.identity).toEqual(state.f.identity);
      expect(state.writes.filter(([operation]) => operation === 'create')).toHaveLength(1);
    });

    test('publisher rejects handoff changes during final absence observation before create', async (t) => {
      const state = await setup(t);
      const list = state.client.list;
      state.client.list = async (endpoint) => {
        const value = await list(endpoint);
        if (endpoint.endsWith('/releases') && state.writes.length === 0) {
          state.f.put(`handoff/assets/${state.f.name}`, 'changed during observation');
        }
        return value;
      };
      await expect(publishRelease(state.options, state.client)).rejects.toThrow(/checksum-mismatch/);
      expect(state.writes).toEqual([]);
      expect(fs.existsSync(state.options.outputRoot)).toBe(false);
    });

    test('publisher waits for uploaded asset inventory without repeating publication writes', async (t) => {
      const state = await setup(t);
      const list = state.client.list;
      let inventories = 0;
      state.client.list = async (endpoint) => {
        if (endpoint.endsWith('/assets') && ++inventories < 3) return [];
        return list(endpoint);
      };
      const result = await publishRelease(state.options, state.client);
      expect(result.receipt.release_id).toBe('42');
      expect(inventories).toBeGreaterThanOrEqual(3);
      expect(state.writes.map(([operation]) => operation)).toEqual([
        'create', ...state.assembly.assets.map(() => 'upload'), 'finalize',
      ]);
      expect(fs.readdirSync(state.options.outputRoot).sort()).toEqual(['readback.json', 'receipt.json']);
    });
  });
});

describe("publisher", () => {
  describe("publisher", { concurrent: true }, () => {
    test('publisher rejects invalid approval, handoff and pre-observation before writes', async (t) => {
      for (const mutation of [
        ({ f }) => f.put('publication-request.json', { schema: 'ci.release-publication-request.v2', releaseVersion: f.identity.version, targetIdentity: f.identity.target_identity, approvalId: 'approved-1', approvalExpiresAt: '2000-01-01T00:00:00Z', releaseIdentity: f.identity.tag, releaseNotesBodySha256: f.identity.body_sha256 }),
        ({ f }) => f.put('release-notes.json', { body: 'unapproved' }),
        ({ f }) => f.put('publication-request.json', { ...JSON.parse(fs.readFileSync(path.join(f.root, 'publication-request.json'))), schema: 'ci.release-publication-request.v1' }),
        ({ f }) => f.put('publication-request.json', { ...JSON.parse(fs.readFileSync(path.join(f.root, 'publication-request.json'))), schema: 'unknown' }),
        ({ f }) => f.put('publication-request.json', { ...JSON.parse(fs.readFileSync(path.join(f.root, 'publication-request.json'))), schema: undefined }),
        ({ f }) => f.put('publication-request.json', { ...JSON.parse(fs.readFileSync(path.join(f.root, 'publication-request.json'))), releaseVersion: undefined }),
        ({ f }) => f.put('publication-request.json', { ...JSON.parse(fs.readFileSync(path.join(f.root, 'publication-request.json'))), targetIdentity: undefined }),
        ({ f }) => f.put('publication-request.json', { ...JSON.parse(fs.readFileSync(path.join(f.root, 'publication-request.json'))), releaseVersion: '9.9.9' }),
        ({ f }) => f.put('publication-request.json', { schema: 'ci.release-publication-request.v2', approvalId: 'approved-1', approvalExpiresAt: '2099-01-01T00:00:00Z', releaseIdentity: f.identity.tag, releaseNotesBodySha256: f.identity.body_sha256, releaseVersion: f.identity.version, targetIdentity: 'different-target' }),
        ({ f, options }) => f.put('before.json', { ...JSON.parse(fs.readFileSync(options.beforePath)), handoff_digest: 'f'.repeat(64) }),
        ({ f }) => f.put(`handoff/assets/${f.name}`, 'changed'),
      ]) {
        const state = await setup(t);
        mutation(state);
        await expect(publishRelease(state.options, state.client)).rejects.toThrow();
        expect(state.writes.length).toBe(0);
        expect(fs.existsSync(state.options.outputRoot)).toBe(false);
      }
    });

    test('publisher rejects moved source, existing draft and unverifiable draft visibility before create', async (t) => {
      for (const kind of ['source', 'existing', 'existing-public', 'permission', 'permission-missing']) {
        const state = await setup(t);
        const original = state.client.json;
        if (kind === 'existing' || kind === 'existing-public') state.client.list = async () => [{ id: '9', tag_name: state.f.identity.tag, draft: kind === 'existing' }];
        else state.client.json = async (endpoint) => {
          if (kind === 'source' && endpoint.includes('/git/tags/')) return { sha: state.f.identity.tag_object_sha, object: { type: 'commit', sha: 'f'.repeat(40) } };
          if (kind === 'permission-missing' && endpoint === '/repos/owner/project') return { full_name: 'owner/project', default_branch: 'main' };
          if (kind === 'permission' && endpoint === '/repos/owner/project') return { full_name: 'owner/project', permissions: { push: false }, default_branch: 'main' };
          return original(endpoint);
        };
        await expect(publishRelease(state.options, state.client)).rejects.toThrow();
        expect(state.writes.length).toBe(0);
      }
    });

    test('publisher leaves provider acceptance to the create response instead of predicting it from the default branch', async (t) => {
      const state = await setup(t);
      const original = state.client.json;
      const predictions = [];
      state.client.json = async (endpoint) => {
        if (endpoint.includes('/commits/') || endpoint.includes('/git/trees/')) { predictions.push(endpoint); throw new Error('unexpected prediction'); }
        return original(endpoint);
      };
      const result = await publishRelease(state.options, state.client);
      expect(result.receipt.release_id).toBe('42');
      expect(predictions).toStrictEqual([]);
    });

    for (const phase of ['create', 'upload', 'finalize', 'readback']) {
      // contract_id: contract.ci-release-publisher.outputs
      // integration_id: release-publisher-partial-failure
      test(`publisher does not retry or recover failed create upload finalize and readback: ${phase}`, async (t) => {
        const state = await setup(t);
        const failures = [];
        const recovery = [];
        for (const operation of ['delete', 'remove', 'replace', 'recover']) {
          state.client[operation] = async (...args) => { recovery.push([operation, ...args]); throw new Error('unexpected-recovery-write'); };
        }
        const method = phase === 'readback' ? 'assetDigest' : phase;
        state.client[method] = async (...args) => { failures.push(args); throw new Error('provider-state-unknown'); };
        await expect(publishRelease(state.options, state.client)).rejects.toThrow();
        expect(failures).toHaveLength(phase === 'readback' ? state.assembly.assets.length : 1);
        const expectedWrites = phase === 'create' ? [] : ['create',
          ...(phase === 'upload' ? [] : state.assembly.assets.map(() => 'upload'))];
        expect(state.writes.map(([operation]) => operation)).toStrictEqual(expectedWrites);
        expect(state.writes.filter(([operation]) => operation !== 'create').every(([, id]) => id === '42')).toBe(true);
        if (phase === 'upload' || phase === 'finalize') expect(failures[0][1]).toBe('42');
        expect(recovery).toStrictEqual([]);
        if (phase === 'readback') {
          expect(new Set(failures.map(([endpoint]) => endpoint)).size).toBe(failures.length);
          expect(state.writes.some(([operation]) => operation === 'finalize')).toBe(false);
        }
        expect(fs.existsSync(path.join(state.options.outputRoot, 'receipt.json'))).toBe(false);
        expect(fs.existsSync(path.join(state.options.outputRoot, 'readback.json'))).toBe(false);
      });
    }
    for (const phase of ['provider', 'tag']) {
      for (const change of ['expiry', 'notes']) {
        // contract_id: contract.ci-release-publisher.outputs
        // integration_id: release-publisher-partial-failure
        test(`publisher does not retry or recover failed create upload finalize and readback: ${phase}-${change}`, async (t) => {
          const state = await setup(t);
          const json = state.client.json;
          let changed = false;
          state.client.json = async (endpoint) => {
            const beforeFinalize = state.writes.some(([operation]) => operation === 'upload');
            const boundary = phase === 'provider' ? endpoint === '/repos/owner/project' : endpoint.includes('/git/tags/');
            if (beforeFinalize && boundary && !changed) {
              changed = true;
              const name = change === 'expiry' ? 'publication-request.json' : 'release-notes.json';
              const value = JSON.parse(fs.readFileSync(path.join(state.f.root, name), 'utf8'));
              state.f.put(name, change === 'expiry' ? { ...value, approvalExpiresAt: '2000-01-01T00:00:00Z' }
                : { ...value, body: 'changed after approval' });
            }
            return json(endpoint);
          };
          await expect(publishRelease(state.options, state.client)).rejects.toThrow(change === 'expiry' ? /approval-expired-or-invalid/ : /release-notes-digest-mismatch/);
          expect(changed).toBe(true);
          expect(state.writes.map(([operation]) => operation)).toStrictEqual(['create', ...state.assembly.assets.map(() => 'upload')]);
          expect(fs.existsSync(path.join(state.options.outputRoot, 'receipt.json'))).toBe(false);
          expect(fs.existsSync(path.join(state.options.outputRoot, 'readback.json'))).toBe(false);
        });
      }
    }

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
            expect(init.method).toBe(method);
            expect(init.redirect).toBe('error');
            expect(new URL(url).hostname).toBe(operation === 'asset-upload' ? 'uploads.github.com' : 'api.github.com');
            if (operation === 'asset-upload') {
              expect(new URL(url).searchParams.get('name')).toBe(asset.name);
              expect(init.headers['content-length']).toBe(String(asset.size));
            }
            if (result === 'network') throw new Error(secret);
            const status = result === 'http' ? 502 : method === 'POST' ? 201 : 200;
            return new Response(result === 'empty' ? null : result === 'oversized' ? 'x'.repeat(4 * 1024 * 1024 + 1)
              : result === 'success' ? '{"id":42}' : secret, { status, headers: { 'x-github-request-id': 'safe:123' } });
          });
          if (result === 'success') expect(await invoke(client)).toStrictEqual({ id: 42 });
          else await expect(invoke(client)).rejects.toSatisfy((error) => {
            expect(!error.message.includes(secret)).toBeTruthy();
            expect(error.message.startsWith('remote-state-unknown:')).toBeTruthy();
            const diagnostic = JSON.parse(error.message.slice('remote-state-unknown:'.length));
            expect(diagnostic.operation).toBe(operation);
            expect(diagnostic.method).toBe(method);
            expect(!diagnostic['sanitized-endpoint'].includes('?')).toBeTruthy();
            expect(diagnostic['http-status']).toBe(result === 'network' ? 'unavailable' : result === 'http' ? 502 : method === 'POST' ? 201 : 200);
            expect(diagnostic['request-id']).toBe(result === 'network' ? 'unavailable' : 'safe:123');
            return true;
          });
          expect(calls).toBe(1);
        }
      }
    });
  });
});
