import { test, describe, expect, vi } from 'vitest';
import fs from 'node:fs';
import { fixture, remoteClient, standardPublicationTokenEnvironment, preObservationFixture } from './fixtures.mjs';
import { GithubReadOnlyClient, observeBefore, verifyAfter, loadAssembly, draftVisibilityFailure, observeAssets } from '../observation.ts';
import { LIMITS, sha256, releaseErrorMessage } from '../io.ts';
import { verifySourceCompatibility, verifySuitability } from '../provider.ts';

const publication = async (t, { realObservation = false } = {}) => {
  const f = fixture(t);
  const assembly = f.assemble();
  const options = { ...f.options, handoffRoot: f.options.outputRoot };
  const before = realObservation ? await observeBefore(options, remoteClient(f, assembly, { ids: [] }).client) : preObservationFixture(options);
  options.beforePath = f.put('before.json', before);
  const { handoffDigest } = loadAssembly(options);
  const receipt = { schema_version: '1', kind: 'ci-github-release-publish-receipt', identity: f.identity, handoff_digest: handoffDigest, asset_digest: assembly.asset_digest, release_id: '42', pre_observation_sha256: sha256(fs.readFileSync(options.beforePath)) };
  const readback = { schema_version: '1', kind: 'ci-github-release-readback', identity: f.identity, handoff_digest: handoffDigest, asset_digest: assembly.asset_digest, release_id: '42', draft: false, assets: assembly.assets, inventory: { ...before, phase: 'post-create', release_ids: ['42'] } };
  options.receiptPath = f.put('receipt.json', receipt);
  options.readbackPath = f.put('readback.json', readback);
  return { f, options, assembly, receipt, readback };
};

describe("contract.ci-release-publication-verifier.outputs", { concurrent: true }, () => {
  describe("release-publication-evidence", () => {
    // contract_id: contract.ci-release-publication-verifier.outputs
    // integration_id: release-publication-evidence
    test('publication evidence matches independent immutable ID readback', async (t) => {
      const { f, options, assembly } = await publication(t, { realObservation: true });
      const { client, calls } = remoteClient(f, assembly);
      const result = await verifyAfter(options, client);
      expect(result.receipt.release_id).toBe('42');
      expect(result.evidence.draft).toBe(false);
      expect(calls.every(([method]) => method === 'GET')).toBeTruthy();
      expect(calls.some(([, endpoint]) => endpoint.endsWith('/releases/42'))).toBeTruthy();
      expect(calls.every(([, endpoint]) => !endpoint.includes('/releases/tags/'))).toBeTruthy();
    });

    // contract_id: contract.ci-release-publication-verifier.outputs
    // integration_id: release-publication-evidence
    test('asset readback overlaps bounded downloads and retains the complete sorted evidence', async (t) => {
      // Arrange
      const f = fixture(t);
      const assembly = { ...f.assemble(), assets: Array.from({ length: 7 }, (_, index) => ({
        name: `asset-${index}.zip`, size: index + 1, sha256: sha256(Buffer.from(`asset-${index}`)),
      })) };
      const { client, calls } = remoteClient(f, assembly);
      const list = client.list;
      client.list = async endpoint => (await list(endpoint)).reverse();
      let active = 0;
      let peak = 0;
      const reads = [];
      client.assetDigest = async (endpoint, size) => {
        const index = Number(endpoint.split('/').at(-1)) - 100;
        reads.push(index);
        expect(size).toBe(assembly.assets[index].size);
        peak = Math.max(peak, ++active);
        await Promise.resolve();
        active--;
        return assembly.assets[index].sha256;
      };
      // Act
      const assets = await observeAssets(f.identity, '42', assembly, client);
      // Assert
      expect(peak).toBe(3);
      expect(active).toBe(0);
      expect(reads.toSorted((a, b) => a - b)).toStrictEqual([0, 1, 2, 3, 4, 5, 6]);
      expect(assets).toStrictEqual(assembly.assets);
      expect(calls.every(([method]) => method === 'GET')).toBe(true);
    });

  });
});

describe('contract.ci-release-publication-verifier.outputs', { concurrent: true }, () => {
  describe('release-publication-rejection', () => {
    for (const kind of ['checksum', 'transport']) {
      // contract_id: contract.ci-release-publication-verifier.outputs
      // integration_id: release-publication-rejection
      test(`asset readback drains started downloads before rejecting ${kind} failure`, async (t) => {
        // Arrange
        const f = fixture(t);
        const assembly = { ...f.assemble(), assets: Array.from({ length: 7 }, (_, index) => ({
          name: `asset-${index}.zip`, size: 1, sha256: sha256(Buffer.from(`asset-${index}`)),
        })) };
        const { client } = remoteClient(f, assembly);
        let active = 0;
        const reads = [];
        client.assetDigest = async endpoint => {
          const index = Number(endpoint.split('/').at(-1)) - 100;
          reads.push(index);
          active++;
          try {
            await Promise.resolve();
            if (index === 0) {
              if (kind === 'transport') throw new Error('remote-state-unknown');
              return 'f'.repeat(64);
            }
            await Promise.resolve();
            return assembly.assets[index].sha256;
          } finally { active--; }
        };
        // Act
        const result = observeAssets(f.identity, '42', assembly, client);
        // Assert
        await expect(result).rejects.toThrow(kind === 'transport' ? /remote-state-unknown/ : /checksum-mismatch/);
        expect(active).toBe(0);
        expect(reads).toStrictEqual([0, 1, 2]);
      });
    }
  });
});

describe("observation", { concurrent: true }, () => {
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

describe("contract.ci-release-publication-verifier.outputs", { concurrent: true }, () => {
  describe("release-publication-rejection", () => {
    // contract_id: contract.ci-release-publication-verifier.outputs
    // integration_id: release-publication-rejection
    test('pre-create reobserves absence and rejects a newly visible draft using GET only', async (t) => {
      // Arrange
      const f = fixture(t);
      const assembly = f.assemble();
      let lists = 0;
      const { client, calls } = remoteClient(f, assembly, { ids: [] });
      client.hasStandardGithubTokenWriteAccess = repository => repository === f.identity.repository;
      const originalJson = client.json;
      client.json = async endpoint => endpoint === '/repos/owner/project'
        ? { full_name: f.identity.repository, permissions: { push: false } } : originalJson(endpoint);
      client.list = async () => ++lists === 1 ? [] : [{ id: 42, tag_name: f.identity.tag, draft: true }];
      // Act
      const result = observeBefore({ ...f.options, handoffRoot: f.options.outputRoot }, client);
      // Assert
      await expect(result).rejects.toThrow(/existing-release-or-asset/);
      expect(lists).toBe(2);
      expect(calls.every(([method]) => method === 'GET')).toBe(true);
    });
    // contract_id: contract.ci-release-publication-verifier.outputs
    // integration_id: release-publication-rejection
    test('pre-create refuses existing releases including drafts', async (t) => {
      const f = fixture(t);
      const assembly = f.assemble();
      await expect(observeBefore({ ...f.options, handoffRoot: f.options.outputRoot }, remoteClient(f, assembly).client)).rejects.toThrow(/existing-release-or-asset/);
    });
  });
});

describe("contract.ci-release-publication-verifier.outputs", { concurrent: true }, () => {
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

describe("contract.ci-release-publication-verifier.outputs", { concurrent: true }, () => {
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

describe("contract.ci-release-publication-verifier.outputs", { concurrent: true }, () => {
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

describe("contract.ci-release-publication-verifier.outputs", { concurrent: true }, () => {
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


describe('safe release diagnostics', () => {
  describe('provider suitability', () => {
    // evidence_role: supplemental
    // integration_id: provider-suitability-diagnostics
    test('source and publication checks retain rejection metadata and workflow digests', async () => {
      // Arrange
      const identity = { repository: 'owner/project', source_sha: 'a'.repeat(40) };
      const cases = [
        ['head', 'source-head-invalid'], ['commit', 'commit-response-invalid'],
        ['tree', 'workflow-tree-invalid'], ['truncated', 'workflow-tree-incomplete'],
        ['entry', 'workflow-tree-entry-invalid'], ['duplicate', 'workflow-tree-duplicate-path'],
        ['moved', 'workflow-source-mismatch'],
      ];
      for (const verify of [verifySourceCompatibility, verifySuitability]) {
        for (const [kind, reason] of cases) {
          const client = {
            async json(endpoint) {
              if (endpoint === '/repos/owner/project') return { full_name: identity.repository, default_branch: 'main', permissions: { push: true } };
              if (endpoint.endsWith('/commits/main')) return { sha: kind === 'head' ? 'invalid' : 'b'.repeat(40) };
              const sha = endpoint.split('/').at(-1).split('?')[0];
              if (endpoint.includes('/git/commits/')) return kind === 'commit' ? {} : { sha, tree: { sha } };
              const entry = { path: '.github/workflows/release.yml', sha: kind === 'moved' && sha === identity.source_sha ? 'd'.repeat(40) : 'c'.repeat(40), mode: '100644', type: 'blob' };
              return kind === 'tree' ? {} : { sha, truncated: kind === 'truncated', tree: kind === 'entry' ? [{}] : kind === 'duplicate' ? [entry, entry] : [entry] };
            },
            responseMetadata: () => ({ status: 200, requestId: 'safe:123' }),
          };
          // Act
          const result = verify(identity, client);
          // Assert
          await expect(result).rejects.toSatisfy(error => {
            expect(releaseErrorMessage(error)).toBe('provider-publication-suitability-unknown-or-unsupported');
            expect(error.details).toMatchObject({ method: 'GET', 'http-status': 200, 'request-id': 'safe:123', 'sanitized-reason': reason });
            if (kind === 'moved') {
              expect(error.details.expected_sha256).toBe(sha256(Buffer.from(JSON.stringify({ '.github/workflows/release.yml': `blob:100644:${'d'.repeat(40)}` }))));
              expect(error.details.observed_sha256).toBe(sha256(Buffer.from(JSON.stringify({ '.github/workflows/release.yml': `blob:100644:${'c'.repeat(40)}` }))));
            }
            return true;
          });
        }
      }
    });

    // evidence_role: supplemental
    // integration_id: provider-suitability-diagnostics
    test('read-only source compatibility preserves permission semantics and safely masks unavailable metadata', async () => {
      // Arrange
      const identity = { repository: 'owner/project', source_sha: 'a'.repeat(40) };
      const client = { json: async endpoint => endpoint === '/repos/owner/project'
        ? { full_name: identity.repository, default_branch: 'main', permissions: { push: false } } : { sha: identity.source_sha } };
      // Act
      const readOnly = verifySourceCompatibility(identity, client);
      const writeCheck = verifySuitability(identity, client);
      // Assert
      await expect(readOnly).resolves.toBeUndefined();
      await expect(writeCheck).rejects.toSatisfy(error => {
        expect(error.details).toMatchObject({ 'sanitized-reason': 'push-permission-denied', 'http-status': 'unavailable', 'request-id': 'unavailable' });
        return true;
      });
      await expect(verifySuitability(identity, { ...client, responseMetadata: () => ({ status: 200, requestId: 'unsafe synthetic-secret' }) })).rejects.toSatisfy(error => {
        expect(JSON.stringify(error.details)).not.toContain('synthetic-secret');
        expect(error.details['request-id']).toBe('unavailable');
        return true;
      });
    });
  });
  describe('GithubReadOnlyClient', () => {
  test('standard workflow token evidence binds caller context capability token and repository', async (t) => {
    const f = fixture(t);
    try {
      const context = standardPublicationTokenEnvironment(f.identity.repository, 'synthetic-secret');
      for (const [changes, allowed] of [
        [{}, true], [{ GITHUB_EVENT_NAME: 'workflow_dispatch' }, false],
        [{ GITHUB_ACTIONS: 'false' }, false], [{ GITHUB_EVENT_NAME: 'pull_request' }, false],
        [{ CI_RELEASE_CREDENTIAL_SOURCE: '' }, false], [{ CI_RELEASE_CONTENTS_PERMISSION: 'read' }, false],
        [{ GITHUB_TOKEN: 'another-token' }, false], [{ GITHUB_REPOSITORY: 'another/project' }, false],
        [{ GITHUB_WORKFLOW_REF: 'owner/project/.github/workflows/custom.yml@refs/heads/main' }, false],
        [{ GITHUB_WORKFLOW_REF: 'owner/project/.github/workflows/release-publication-caller.yml@refs/heads/Main' }, false],
      ]) {
        for (const [key, value] of Object.entries({ ...context, ...changes })) vi.stubEnv(key, value);
        const client = new GithubReadOnlyClient('synthetic-secret');
        expect(client.hasStandardGithubTokenWriteAccess(f.identity.repository)).toBe(allowed);
        expect(client.hasStandardGithubTokenWriteAccess('another/repository')).toBe(false);
        for (const repository of [{}, { permissions: {} }]) {
          expect(draftVisibilityFailure(repository, f.identity, client)).toBe(allowed ? undefined : repository.permissions ? 'push-permission-missing' : 'permissions-missing');
        }
        expect(draftVisibilityFailure({ permissions: { push: false } }, f.identity, client)).toBe(allowed ? undefined : 'push-permission-denied');
        expect(draftVisibilityFailure({ permissions: { push: 'invalid' } }, f.identity, client)).toBe('push-permission-invalid');
        expect(draftVisibilityFailure({ permissions: [] }, f.identity, client)).toBe('permissions-missing');
      }
    } finally { vi.unstubAllEnvs(); }
  });

  test('asset inventory reobservation remains bounded and refuses invalid subsets immediately', async (t) => {
    const f = fixture(t);
    const assembly = f.assemble();
    for (const [assets, expectedReads] of [[[], 3], [[{ id: '100', name: 'unexpected', size: 1, state: 'uploaded' }], 1]]) {
      let reads = 0;
      const client = { list: async () => { reads++; return assets; }, assetDigest: async () => { throw new Error('readback-before-complete-inventory'); } };
      await expect(observeAssets(f.identity, '42', assembly, client)).rejects.toThrow(/asset-set-mismatch/);
      expect(reads).toBe(expectedReads);
    }
  });
  test('inventory diagnostics retain the failing page correlation after later pages', async (t) => {
    // Arrange
    const f = fixture(t);
    f.assemble();
    const client = new GithubReadOnlyClient('synthetic-secret', async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname.includes('/git/ref/tags/')) return Response.json({ object: { type: 'tag', sha: f.identity.tag_object_sha } });
      if (parsed.pathname.includes('/git/tags/')) return Response.json({ sha: f.identity.tag_object_sha, object: { type: 'commit', sha: f.identity.source_sha } });
      if (parsed.pathname.endsWith('/releases')) return parsed.searchParams.get('page') === '1'
        ? Response.json(Array.from({ length: 100 }, (_, i) => ({ id: i + 1, tag_name: i === 0 ? null : 'other', draft: false })), { headers: { 'x-github-request-id': 'first:123' } })
        : Response.json([], { headers: { 'x-github-request-id': 'last:456' } });
      return Response.json({ full_name: f.identity.repository, permissions: { push: true } });
    });
    // Act
    const result = observeBefore({ ...f.options, handoffRoot: f.options.outputRoot }, client);
    // Assert
    await expect(result).rejects.toSatisfy((error) => {
      const diagnostic = JSON.parse(releaseErrorMessage(error).slice('remote-state-unknown:'.length));
      expect(diagnostic['sanitized-reason']).toBe('response-shape-invalid');
      expect(diagnostic['http-status']).toBe(200);
      expect(diagnostic['request-id']).toBe('first:123');
      return true;
    });
  });
  test('body timeouts retain response correlation for JSON and asset readback', async () => {
    for (const binary of [false, true]) {
      const client = new GithubReadOnlyClient('synthetic-secret', async () => new Response(new ReadableStream({
        start(controller) { controller.error(new DOMException('synthetic-secret', 'AbortError')); },
      }), { headers: { 'x-github-request-id': 'safe:123' } }));
      const endpoint = binary ? '/repos/owner/project/releases/assets/1' : '/repos/owner/project';
      await expect(binary ? client.assetDigest(endpoint, 1) : client.json(endpoint)).rejects.toSatisfy((error) => {
        const message = releaseErrorMessage(error);
        const diagnostic = JSON.parse(message.slice('remote-state-unknown:'.length));
        expect(diagnostic.phase).toBe('response');
        expect(diagnostic.operation).toBe(binary ? 'asset-readback' : 'remote-observation');
        expect(diagnostic['sanitized-reason']).toBe('request-timeout');
        expect(diagnostic['http-status']).toBe(200);
        expect(diagnostic['request-id']).toBe('safe:123');
        expect(message).not.toContain('synthetic-secret');
        return true;
      });
    }
  });
  });
  describe('releaseErrorMessage', () => {
  test('final diagnostic boundary accepts only bounded standard installer cleanup evidence', () => {
    const diagnostic = { operation: 'standard-installer', phase: 'assemble', 'sanitized-reason': 'installer-cleanup-failed',
      cleanup: { status: 'failed', 'temporary-state': 'unknown' } };
    const message = `standard-installer-failed:${JSON.stringify(diagnostic)}`;
    expect(releaseErrorMessage(new Error(message))).toBe(message);
    for (const cleanup of [null, { status: 'synthetic-secret', 'temporary-state': 'unknown' },
      { status: 'failed', 'temporary-state': 'unknown', path: 'synthetic-secret' }]) {
      expect(releaseErrorMessage(new Error(`standard-installer-failed:${JSON.stringify({ ...diagnostic, cleanup })}`))).toBe('standard-installer-failed');
    }
  });

  test('final diagnostic boundary rejects arbitrary fields and malformed envelopes', () => {
    const diagnostic = { operation: 'remote-observation', phase: 'request', method: 'GET',
      'sanitized-endpoint': '/repos/owner/project', 'http-status': 403, 'request-id': 'safe:123', 'sanitized-reason': 'provider-read-failed' };
    const valid = `remote-state-unknown:${JSON.stringify(diagnostic)}`;
    expect(releaseErrorMessage(new Error(valid))).toBe(valid);
    for (const value of [{ ...diagnostic, token: 'synthetic-secret' }, { ...diagnostic, operation: 'synthetic-secret' },
      { ...diagnostic, 'sanitized-endpoint': 'https://example.invalid/synthetic-secret' },
      { ...diagnostic, 'request-id': 'unsafe\nsynthetic-secret' }, { ...diagnostic, phase: { toString: 'request', secret: 'synthetic-secret' } }]) {
      expect(releaseErrorMessage(new Error(`remote-state-unknown:${JSON.stringify(value)}`))).toBe('remote-state-unknown');
    }
    expect(releaseErrorMessage(new Error('remote-state-unknown:{synthetic-secret'))).toBe('remote-state-unknown');
  });
  });
  describe('assetDigest', () => {
  test('asset readback diagnoses unsafe redirects without disclosing signed locations', async () => {
    for (const location of [null, 'invalid-secret', 'https://evil.example/signed-secret']) {
      const client = new GithubReadOnlyClient('synthetic-secret', async () => new Response(null, { status: 302,
        headers: location === null ? {} : { location } }));
      await expect(client.assetDigest('/repos/owner/project/releases/assets/1', 1)).rejects.toSatisfy((error) => {
        const message = releaseErrorMessage(error);
        const diagnostic = JSON.parse(message.slice('remote-state-unknown:'.length));
        expect(diagnostic.operation).toBe('asset-readback');
        expect(diagnostic['sanitized-reason']).toBe(location === null ? 'redirect-missing' : 'redirect-invalid');
        expect(message).not.toContain('secret');
        return true;
      });
    }
  });
  });
});
