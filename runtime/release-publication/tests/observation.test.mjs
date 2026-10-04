import { test, describe, expect } from 'vitest';
import fs from 'node:fs';
import { fixture, remoteClient } from './fixtures.mjs';
import { GithubReadOnlyClient, observeBefore, verifyAfter, loadAssembly } from '../observation.ts';
import { LIMITS, sha256 } from '../io.ts';

const publication = async (t) => {
  const f = fixture(t);
  const assembly = f.assemble();
  const options = { ...f.options, handoffRoot: f.options.outputRoot };
  const before = await observeBefore(options, remoteClient(f, assembly, { ids: [] }).client);
  options.beforePath = f.put('before.json', before);
  const { handoffDigest } = loadAssembly(options);
  const receipt = { schema_version: '1', kind: 'ci-github-release-publish-receipt', identity: f.identity, handoff_digest: handoffDigest, asset_digest: assembly.asset_digest, release_id: '42', pre_observation_sha256: sha256(fs.readFileSync(options.beforePath)) };
  const readback = { schema_version: '1', kind: 'ci-github-release-readback', identity: f.identity, handoff_digest: handoffDigest, asset_digest: assembly.asset_digest, release_id: '42', draft: false, assets: assembly.assets, inventory: { ...before, phase: 'post-create', release_ids: ['42'] } };
  options.receiptPath = f.put('receipt.json', receipt);
  options.readbackPath = f.put('readback.json', readback);
  return { f, options, assembly, receipt, readback };
};

describe("contract.ci-release-publication-verifier.outputs", () => {
  describe("release-publication-evidence", () => {
    // contract_id: contract.ci-release-publication-verifier.outputs
    // integration_id: release-publication-evidence
    test('publication evidence matches independent immutable ID readback', async (t) => {
      const { f, options, assembly } = await publication(t);
      const { client, calls } = remoteClient(f, assembly);
      const result = await verifyAfter(options, client);
      expect(result.receipt.release_id).toBe('42');
      expect(result.evidence.draft).toBe(false);
      expect(calls.every(([method]) => method === 'GET')).toBeTruthy();
      expect(calls.some(([, endpoint]) => endpoint.endsWith('/releases/42'))).toBeTruthy();
      expect(calls.every(([, endpoint]) => !endpoint.includes('/releases/tags/'))).toBeTruthy();
    });
  });
});

describe("observation", () => {
  describe("observation", () => {
    for (const [label, changes, error] of [
      ['draft', { draft: true }, /tag-version-asset-checksum-or-body-mismatch/],
      ['body', { body: 'other' }, /tag-version-asset-checksum-or-body-mismatch/],
      ['source', { sourceSha: 'c'.repeat(40) }, /source-identity-mismatch/],
      ['asset set', { assets: [] }, /asset-set-mismatch/],
      ['checksum', { digest: 'c'.repeat(64) }, /checksum-mismatch/],
      ['duplicate release', { ids: ['42', '43'] }, /existing-release-or-asset/],
      ['different release', { ids: ['43'] }, /existing-release-or-asset/],
      ['draft visibility unknown', { push: false }, /remote-state-unknown/],
    ]) {
      // contract_id: contract.ci-release-publication-verifier.outputs
      // integration_id: release-publication-rejection
      test(`publication verification fails closed: ${label}`, async (t) => {
        const { f, options, assembly } = await publication(t);
        await expect(verifyAfter(options, remoteClient(f, assembly, changes).client)).rejects.toThrow(error);
      });
    }
  });
});

describe("contract.ci-release-publication-verifier.outputs", () => {
  describe("release-publication-rejection", () => {
    // contract_id: contract.ci-release-publication-verifier.outputs
    // integration_id: release-publication-rejection
    test('pre-create refuses existing releases including drafts', async (t) => {
      const f = fixture(t);
      const assembly = f.assemble();
      await expect(observeBefore({ ...f.options, handoffRoot: f.options.outputRoot }, remoteClient(f, assembly).client)).rejects.toThrow(/existing-release-or-asset/);
    });
  });
});

describe("contract.ci-release-publication-verifier.outputs", () => {
  describe("release-publication-receipt-binding", () => {
    // contract_id: contract.ci-release-publication-verifier.outputs
    // integration_id: release-publication-receipt-binding
    test('receipt and readback missing or mismatching bindings are rejected', async (t) => {
      const { f, options, assembly, receipt, readback } = await publication(t);
      receipt.pre_observation_sha256 = 'c'.repeat(64);
      f.put('receipt.json', receipt);
      await expect(verifyAfter(options, remoteClient(f, assembly).client)).rejects.toThrow(/receipt-mismatch/);
      receipt.pre_observation_sha256 = sha256(fs.readFileSync(options.beforePath));
      f.put('receipt.json', receipt);
      readback.release_id = '43';
      f.put('readback.json', readback);
      await expect(verifyAfter(options, remoteClient(f, assembly).client)).rejects.toThrow(/readback-evidence-mismatch/);
      delete receipt.release_id;
      f.put('receipt.json', receipt);
      await expect(verifyAfter(options, remoteClient(f, assembly).client)).rejects.toThrow(/schema-mismatch/);
    });
  });
});

describe("contract.ci-release-publication-verifier.outputs", () => {
  describe("release-publication-transport", () => {
    // contract_id: contract.ci-release-publication-verifier.outputs
    // integration_id: release-publication-transport
    test('read-only transport completes pagination and rejects unknown remote state', async () => {
      const calls = [];
      const client = new GithubReadOnlyClient('test-token', async (url, init) => {
        calls.push([url, init]);
        return new Response(JSON.stringify(new URL(url).searchParams.get('page') === '1' ? Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })) : [{ id: 101 }]));
      });
      expect((await client.list('/repos/owner/project/releases')).length).toBe(101);
      expect(calls.every(([, init]) => init.method === 'GET' && init.redirect === 'manual')).toBeTruthy();
      const denied = new GithubReadOnlyClient('private-token', async () => new Response('private-token', { status: 403 }));
      await expect(denied.json('/repos/owner/project')).rejects.toSatisfy((error) => error.message.includes('"http-status":403') && !error.message.includes('private-token'));
      const duplicate = new GithubReadOnlyClient('token', async () => new Response(JSON.stringify([{ id: 1 }, { id: 1 }])));
      await expect(duplicate.list('/repos/owner/project/releases')).rejects.toThrow(/remote-state-unknown/);
    });

    // contract_id: contract.ci-release-publication-verifier.outputs
    // integration_id: release-publication-transport
    test('read-only transport refuses an inventory that never completes within the page limit', async () => {
      let pages = 0;
      const client = new GithubReadOnlyClient('token', async () => {
        pages++;
        return new Response(JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ id: (pages - 1) * 100 + index + 1 }))));
      });
      await expect(client.list('/repos/owner/project/releases')).rejects.toThrow(/remote-state-unknown/);
      expect(pages).toBe(LIMITS.pages);
    });
  });
});

describe("contract.ci-release-publication-verifier.outputs", () => {
  describe("release-publication-rejection", () => {
    // contract_id: contract.ci-release-publication-verifier.outputs
    // integration_id: release-publication-rejection
    test('publication verification refuses an inventory still absent after bounded reobservation', async (t) => {
      const { f, options, assembly } = await publication(t);
      const { client, calls } = remoteClient(f, assembly, { ids: [] });
      await expect(verifyAfter(options, client)).rejects.toThrow(/remote-state-unknown/);
      expect(calls.filter(([, endpoint]) => endpoint.endsWith('/releases')).length).toBe(3);
    });
  });
});

describe("contract.ci-release-publication-verifier.outputs", () => {
  describe("release-publication-transport", () => {
    // contract_id: contract.ci-release-publication-verifier.outputs
    // integration_id: release-publication-transport
    test('asset redirects never receive authorization and foreign hosts are rejected', async () => {
      const calls = [];
      const bytes = Buffer.from('asset');
      const client = new GithubReadOnlyClient('secret', async (url, init) => {
        calls.push([String(url), init]);
        return calls.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/asset?signed=private' } }) : new Response(bytes);
      });
      expect(await client.assetDigest('/repos/owner/project/releases/assets/1', bytes.length)).toBe(sha256(bytes));
      expect(calls[1][1].headers).toBe(undefined);
      const foreign = new GithubReadOnlyClient('secret', async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/secret' } }));
      await expect(foreign.assetDigest('/repos/owner/project/releases/assets/1', bytes.length)).rejects.toThrow(/remote-state-unknown/);
    });
  });
});
