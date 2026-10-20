import { describe, test, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import { fixture, remoteClient, preObservationFixture } from './fixtures.mjs';
import { observeBefore, verifyAfter, loadAssembly } from '../observation.ts';
import { sha256 } from '../io.ts';

const publication = t => {
  const f = fixture(t);
  const assembly = f.assemble();
  const options = { ...f.options, handoffRoot: f.options.outputRoot };
  const before = preObservationFixture(options);
  options.beforePath = f.put('before.json', before);
  const { handoffDigest } = loadAssembly(options);
  const receipt = { schema_version: '1', kind: 'ci-github-release-publish-receipt', identity: f.identity,
    handoff_digest: handoffDigest, asset_digest: assembly.asset_digest, release_id: '42',
    pre_observation_sha256: sha256(fs.readFileSync(options.beforePath)) };
  options.receiptPath = f.put('receipt.json', receipt);
  options.readbackPath = f.put('readback.json', { schema_version: '1', kind: 'ci-github-release-readback',
    identity: f.identity, handoff_digest: handoffDigest, asset_digest: assembly.asset_digest,
    release_id: '42', draft: false, assets: assembly.assets,
    inventory: { ...before, phase: 'post-create', release_ids: ['42'] } });
  return { f, options, assembly };
};

const guarded = (client, calls) => new Proxy(client, {
  get(target, key) {
    if (key in target || ['responseMetadata', 'hasStandardGithubTokenWriteAccess'].includes(key)) return target[key];
    return () => { calls.push(['unexpected-method', String(key)]); throw new Error('unexpected-provider-method'); };
  },
});

// A separate file isolates the fake clock from concurrently running observation tests.
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('contract.ci-release-publication-verifier.outputs', () => {
  describe('read-only-observation-policy', () => {
    // contract_id: contract.ci-release-publication-verifier.outputs
    // integration_id: read-only-observation-policy
    test('absence observation uses three GET-only inventories one second apart', async t => {
      // Arrange
      const { f, options, assembly } = publication(t);
      const { client, calls } = remoteClient(f, assembly, { ids: [] });
      vi.useFakeTimers();
      const sleeps = vi.spyOn(globalThis, 'setTimeout');
      // Act
      const result = observeBefore(options, guarded(client, calls));
      await vi.runAllTimersAsync();
      // Assert
      expect((await result).release_ids).toStrictEqual([]);
      expect(calls.filter(([, endpoint]) => endpoint.endsWith('/releases'))).toHaveLength(3);
      expect(calls.filter(([, endpoint]) => endpoint.endsWith('/assets'))).toHaveLength(0);
      expect(calls.every(([method]) => method === 'GET')).toBe(true);
      expect(sleeps.mock.calls.map(([, delay]) => delay)).toStrictEqual([1000, 1000]);
    });

    // contract_id: contract.ci-release-publication-verifier.outputs
    // integration_id: read-only-observation-policy
    test('post verification bounds Release and asset reobservation with GET-only requests', async t => {
      // Arrange
      const { f, options, assembly } = publication(t);
      const { client, calls } = remoteClient(f, assembly);
      const list = client.list;
      let assets = 0;
      let releases = 0;
      client.list = async endpoint => {
        const value = await list(endpoint);
        const count = endpoint.endsWith('/assets') ? ++assets : ++releases;
        return count < 3 ? [] : value;
      };
      vi.useFakeTimers();
      const sleeps = vi.spyOn(globalThis, 'setTimeout');
      // Act
      const result = verifyAfter(options, guarded(client, calls));
      await vi.runAllTimersAsync();
      // Assert
      expect((await result).evidence.release_id).toBe('42');
      expect(releases).toBe(3);
      expect(assets).toBe(3);
      expect(calls.every(([method]) => method === 'GET')).toBe(true);
      expect(sleeps.mock.calls.map(([, delay]) => delay)).toStrictEqual([1000, 1000, 1000, 1000]);
    });

    // contract_id: contract.ci-release-publication-verifier.outputs
    // integration_id: read-only-observation-policy
    test('missing Release rejects after three GET-only inventories', async t => {
      // Arrange
      const { f, options, assembly } = publication(t);
      const { client, calls } = remoteClient(f, assembly, { ids: [] });
      vi.useFakeTimers();
      const sleeps = vi.spyOn(globalThis, 'setTimeout');
      // Act
      const result = verifyAfter(options, guarded(client, calls)).catch(error => error);
      await vi.runAllTimersAsync();
      // Assert
      expect(await result).toBeInstanceOf(Error);
      expect((await result).message).toMatch(/release-not-visible/);
      expect(calls.filter(([, endpoint]) => endpoint.endsWith('/releases'))).toHaveLength(3);
      expect(calls.filter(([, endpoint]) => endpoint.endsWith('/assets'))).toHaveLength(1);
      expect(calls.every(([method]) => method === 'GET')).toBe(true);
      expect(sleeps.mock.calls.map(([, delay]) => delay)).toStrictEqual([1000, 1000]);
    });
  });
});
