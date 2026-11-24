// flow_id: release-publication-verifier-entrypoint-observation
// test_level: e2e
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { describe, test, expect, type TestContext } from 'vitest';
import { fixture } from '../../../runtime/release-publication/tests/fixtures.mjs';

import { actionEntrypointArguments, runActionEntrypoint } from '../../../tests/support/action-entrypoint';

// The preload answers the provider endpoints from MOCK_SCENARIO, records every request, and records each requested
// timer delay at the runner clock boundary while firing it at once so that bounded reobservation stays fast.
const scenarioFetch = `
import fs from 'node:fs';
import path from 'node:path';
const assembly = JSON.parse(fs.readFileSync(path.join(process.env.MOCK_HANDOFF, 'assembly.json')));
const scenario = JSON.parse(process.env.MOCK_SCENARIO);
const record = (entry) => fs.appendFileSync(process.env.MOCK_CALLS, JSON.stringify(entry) + '\\n');
const nativeSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) => { record({ timer: delay }); return nativeSetTimeout(callback, 0, ...args); };
const counts = {};
const next = (key, sequence) => { counts[key] = (counts[key] ?? 0) + 1; return sequence[Math.min(counts[key], sequence.length) - 1]; };
const listedAssets = () => assembly.assets.map((asset, index) => ({ id: index + 100, name: asset.name, size: asset.size, state: 'uploaded' }));
globalThis.fetch = async (url, init) => {
  const endpoint = new URL(String(url)).pathname;
  record({ method: init?.method ?? 'GET', endpoint });
  if (init?.method !== 'GET') throw new Error('write-forbidden');
  const tag = assembly.identity.tag;
  if (endpoint.includes('/git/ref/tags/')) return Response.json({ object: { type: 'tag', sha: assembly.identity.tag_object_sha } });
  if (endpoint.includes('/git/tags/')) return Response.json({ sha: assembly.identity.tag_object_sha, object: { type: 'commit', sha: assembly.identity.source_sha } });
  if (endpoint.endsWith('/releases/42/assets')) {
    const kind = next('assets', scenario.assets ?? ['complete']);
    return Response.json(kind === 'complete' ? listedAssets() : kind === 'empty' ? [] : [{ id: 100, name: 'unexpected', size: 1, state: 'uploaded' }]);
  }
  if (endpoint.includes('/releases/assets/')) {
    const index = Number(endpoint.split('/').at(-1)) - 100;
    const failure = scenario.assetFailure?.[index];
    if (failure === 'transport') throw new Error('synthetic transport failure');
    const bytes = fs.readFileSync(path.join(process.env.MOCK_HANDOFF, 'assets', assembly.assets[index].name));
    return new Response(failure === 'checksum' ? Buffer.alloc(bytes.length, 120) : bytes);
  }
  if (endpoint.endsWith('/releases/42')) return Response.json({ id: 42, tag_name: tag, draft: false, body: 'approved notes' });
  if (endpoint.endsWith('/releases')) {
    const kind = next('releases', scenario.releases);
    return Response.json(kind === 'absent' ? [] : [{ id: 42, tag_name: tag, draft: kind === 'draft' }]);
  }
  return Response.json({ full_name: assembly.identity.repository, permissions: { push: true } });
};
`;

type Call = { method?: string; endpoint?: string; timer?: number };
const hash = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');

describe.each(['source', 'dist'] as const)('%s entrypoint', { concurrent: true }, (surface) => {
  const entrypointArgs = actionEntrypointArguments(path.resolve(__dirname, '..'), surface);

  const setup = (t: TestContext) => {
    const f = fixture(t);
    f.assemble();
    const mock = f.put('scenario-fetch.mjs', scenarioFetch);
    const output = f.put('github-output', '');
    const beforePath = path.join(f.root, 'before.json');
    const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output, GH_TOKEN: 'synthetic-secret',
      INPUT_REPOSITORY: f.options.repository, 'INPUT_AUTHORITY-PATH': f.options.authorityPath,
      'INPUT_HANDOFF-ROOT': f.options.outputRoot, 'INPUT_OBSERVATION-PATH': beforePath, MOCK_HANDOFF: f.options.outputRoot };
    const run = async (operation: string, scenario: Record<string, unknown>, extra: Record<string, string> = {}) => {
      const calls = f.put(`calls-${crypto.randomUUID()}.jsonl`, '');
      fs.writeFileSync(output, '');
      const result = await runActionEntrypoint(['--import', mock, ...entrypointArgs], { cwd: f.root, env: {
        ...env, INPUT_OPERATION: operation, MOCK_SCENARIO: JSON.stringify(scenario), MOCK_CALLS: calls, ...extra } });
      const log = fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Call);
      const requests = log.filter(entry => entry.endpoint);
      return {
        result,
        outputs: fs.readFileSync(output, 'utf8'),
        requests,
        releaseInventories: requests.filter(entry => entry.endpoint!.endsWith('/releases')).length,
        assetInventories: requests.filter(entry => entry.endpoint!.endsWith('/assets')).length,
        delays: log.filter(entry => entry.timer !== undefined).map(entry => entry.timer),
      };
    };
    // Builds receipt and readback evidence bound to one successful absence observation, as the publisher would.
    const afterInputs = async (change: (receipt: Record<string, unknown>, readback: Record<string, unknown>) => void = () => {}) => {
      if (!fs.existsSync(beforePath)) {
        const before = await run('observe-before', { releases: ['absent'] });
        expect(before.result.status, before.result.stderr).toBe(0);
      }
      const assembly = JSON.parse(fs.readFileSync(path.join(f.options.outputRoot, 'assembly.json'), 'utf8'));
      const handoffDigest = hash(fs.readFileSync(path.join(f.options.outputRoot, 'handoff.json')));
      const receipt = { schema_version: '1', kind: 'ci-github-release-publish-receipt', identity: assembly.identity, handoff_digest: handoffDigest,
        asset_digest: assembly.asset_digest, release_id: '42', pre_observation_sha256: hash(fs.readFileSync(beforePath)) };
      const readback = { schema_version: '1', kind: 'ci-github-release-readback', identity: assembly.identity, handoff_digest: handoffDigest,
        asset_digest: assembly.asset_digest, release_id: '42', draft: false, assets: assembly.assets,
        inventory: { ...JSON.parse(fs.readFileSync(beforePath, 'utf8')), phase: 'post-create', release_ids: ['42'] } };
      change(receipt, readback);
      return { 'INPUT_RECEIPT-PATH': f.put('receipt.json', receipt), 'INPUT_READBACK-PATH': f.put('readback.json', readback) };
    };
    return { f, beforePath, run, afterInputs };
  };
  const expectRejected = (outcome: Awaited<ReturnType<ReturnType<typeof setup>['run']>>, reason: RegExp) => {
    expect(outcome.result.status).toBe(1);
    expect(outcome.outputs).toBe('');
    expect(outcome.result.stderr).toMatch(reason);
    expect(outcome.result.stderr).not.toContain('synthetic-secret');
  };

  // contract_id: contract.ci-release-publication-verifier.outputs
  test('publication entrypoint observes absence using GET only', async (t) => {
    // Arrange
    const { run } = setup(t);
    // Act
    const outcome = await run('observe-before', { releases: ['absent'] });
    // Assert
    expect(outcome.result.status, outcome.result.stderr).toBe(0);
    expect(outcome.requests.every(entry => entry.method === 'GET')).toBe(true);
  });

  // evidence_role: supplemental
  // The observation file and its digest, the number of inventory observations and the requested delays are implementation details that no contract guarantee covers.
  test('publication entrypoint writes the observation file after three Release inventories one second apart', async (t) => {
    // Arrange
    const { run, beforePath } = setup(t);
    // Act
    const outcome = await run('observe-before', { releases: ['absent'] });
    // Assert
    expect(outcome.result.status, outcome.result.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(beforePath, 'utf8')).release_ids).toStrictEqual([]);
    expect(outcome.outputs).toContain(`observation-path=${beforePath}\n`);
    expect(outcome.outputs).toContain(`observation-digest=${hash(fs.readFileSync(beforePath))}\n`);
    expect(outcome.releaseInventories).toBe(3);
    expect(outcome.assetInventories).toBe(0);
    expect(outcome.delays).toStrictEqual([1000, 1000]);
  });

  // contract_id: contract.ci-release-publication-verifier.outputs
  test('publication entrypoint rejects an existing draft before create', async (t) => {
    // Arrange
    const { run } = setup(t);
    // Act
    const outcome = await run('observe-before', { releases: ['draft'] });
    // Assert
    expectRejected(outcome, /existing-release-or-asset/);
  });

  // contract_id: contract.ci-release-publication-verifier.outputs
  test('publication entrypoint reobserves absence and rejects a newly visible draft using GET only', async (t) => {
    // Arrange
    const { run } = setup(t);
    // Act
    const outcome = await run('observe-before', { releases: ['absent', 'draft'] });
    // Assert
    expectRejected(outcome, /existing-release-or-asset/);
    expect(outcome.requests.every(entry => entry.method === 'GET')).toBe(true);
  });

  // evidence_role: supplemental
  // Writing no observation file when the pre-create observation is rejected, and the number of inventories before the rejection, are side effects that no contract guarantee covers.
  test('publication entrypoint writes no observation file when it rejects a visible draft', async (t) => {
    // Arrange
    const { run, beforePath } = setup(t);
    for (const [releases, inventories] of [[['draft'], 1], [['absent', 'draft'], 2]] as const) {
      // Act
      const outcome = await run('observe-before', { releases });
      // Assert
      expectRejected(outcome, /existing-release-or-asset/);
      expect(outcome.releaseInventories).toBe(inventories);
      expect(fs.existsSync(beforePath)).toBe(false);
    }
  });

  // contract_id: contract.ci-release-publication-verifier.outputs
  test('publication entrypoint verifies the published Release using GET only', async (t) => {
    // Arrange
    const { run, afterInputs } = setup(t);
    const inputs = await afterInputs();
    // Act
    const outcome = await run('verify-after', { releases: ['absent', 'absent', 'published'], assets: ['empty', 'empty', 'complete'] }, inputs);
    // Assert
    expect(outcome.result.status, outcome.result.stderr).toBe(0);
    expect(outcome.outputs).toMatch(/release-remote-identity=42\n/);
    expect(outcome.requests.every(entry => entry.method === 'GET')).toBe(true);
  });

  // evidence_role: supplemental
  // The number of Release and asset inventories, the requested delays, the asset body requests and the absence of observation outputs are implementation details that no contract guarantee covers.
  test('publication entrypoint bounds Release and asset reobservation after create and reads the asset bodies', async (t) => {
    // Arrange
    const { run, afterInputs } = setup(t);
    const inputs = await afterInputs();
    // Act
    const outcome = await run('verify-after', { releases: ['absent', 'absent', 'published'], assets: ['empty', 'empty', 'complete'] }, inputs);
    // Assert
    expect(outcome.result.status, outcome.result.stderr).toBe(0);
    expect(outcome.outputs).not.toMatch(/observation-(path|digest)=/);
    expect(outcome.releaseInventories).toBe(3);
    expect(outcome.assetInventories).toBe(3);
    expect(outcome.requests.some(entry => entry.endpoint!.includes('/releases/assets/'))).toBe(true);
    expect(outcome.delays).toStrictEqual([1000, 1000, 1000, 1000]);
  });

  // contract_id: contract.ci-release-publication-verifier.outputs
  test('publication entrypoint rejects a Release that stays absent after create using GET only', async (t) => {
    // Arrange
    const { run, afterInputs } = setup(t);
    const inputs = await afterInputs();
    // Act
    const outcome = await run('verify-after', { releases: ['absent'] }, inputs);
    // Assert
    expectRejected(outcome, /release-not-visible/);
    expect(outcome.requests.every(entry => entry.method === 'GET')).toBe(true);
  });

  // evidence_role: supplemental
  // The number of inventory observations and the requested delays before the rejection are implementation details that no contract guarantee covers.
  test('publication entrypoint observes a Release that stays absent three times one second apart', async (t) => {
    // Arrange
    const { run, afterInputs } = setup(t);
    const inputs = await afterInputs();
    // Act
    const outcome = await run('verify-after', { releases: ['absent'] }, inputs);
    // Assert
    expectRejected(outcome, /release-not-visible/);
    expect(outcome.releaseInventories).toBe(3);
    expect(outcome.assetInventories).toBe(1);
    expect(outcome.delays).toStrictEqual([1000, 1000]);
  });

  // contract_id: contract.ci-release-publication-verifier.outputs
  test('publication entrypoint refuses an invalid asset subset', async (t) => {
    // Arrange
    const { run, afterInputs } = setup(t);
    const inputs = await afterInputs();
    for (const assets of ['empty', 'unexpected'] as const) {
      // Act
      const outcome = await run('verify-after', { releases: ['published'], assets: [assets] }, inputs);
      // Assert
      expectRejected(outcome, /asset-set-mismatch/);
    }
  });

  // evidence_role: supplemental
  // The number of asset inventory observations and the absence of asset body requests before the rejection are implementation details that no contract guarantee covers.
  test('publication entrypoint bounds asset inventory reobservation and reads no asset body for an invalid subset', async (t) => {
    // Arrange
    const { run, afterInputs } = setup(t);
    const inputs = await afterInputs();
    for (const [assets, expectedInventories] of [['empty', 3], ['unexpected', 1]] as const) {
      // Act
      const outcome = await run('verify-after', { releases: ['published'], assets: [assets] }, inputs);
      // Assert
      expectRejected(outcome, /asset-set-mismatch/);
      expect(outcome.assetInventories, assets).toBe(expectedInventories);
      expect(outcome.requests.some(entry => entry.endpoint!.includes('/releases/assets/'))).toBe(false);
    }
  });

  // contract_id: contract.ci-release-publication-verifier.outputs
  test('publication entrypoint rejects receipt and readback evidence with mismatching bindings', async (t) => {
    // Arrange
    const { run, afterInputs } = setup(t);
    for (const [change, reason] of [
      [(receipt: Record<string, unknown>) => { receipt.pre_observation_sha256 = 'c'.repeat(64); }, /receipt-mismatch/],
      [(_receipt: Record<string, unknown>, readback: Record<string, unknown>) => { readback.release_id = '43'; }, /readback-evidence-mismatch/],
    ] as const) {
      const inputs = await afterInputs(change);
      // Act
      const outcome = await run('verify-after', { releases: ['published'] }, inputs);
      // Assert
      expectRejected(outcome, reason);
    }
  });

  type Fixture = ReturnType<typeof setup>['f'];
  const localRejections: [string, string, (f: Fixture) => Record<string, string>, string | undefined][] = [
    ['an unsupported operation', 'publish', () => ({}), undefined],
    ['an unreadable authority', 'observe-before', (f) => ({ 'INPUT_AUTHORITY-PATH': f.put('invalid-authority.json', 'not-json') }), undefined],
    ['a missing handoff root', 'observe-before', (f) => ({ 'INPUT_HANDOFF-ROOT': path.join(f.root, 'missing-handoff') }), undefined],
    ['an observation file that cannot be written', 'observe-before', (f) => ({ 'INPUT_OBSERVATION-PATH': f.root }), 'observation-write'],
    ['Action outputs that cannot be written', 'observe-before', (f) => ({ GITHUB_OUTPUT: f.root }), 'output-write'],
  ];
  for (const [label, operation, extra, stage] of localRejections) {
    // contract_id: contract.ci-release-publication-verifier.outputs
    test(`publication entrypoint rejects ${label}`, async (t) => {
      // Arrange
      const { f, run } = setup(t);
      // Act
      const outcome = await run(operation, { releases: ['absent'] }, extra(f));
      // Assert
      expect(outcome.result.status).toBe(1);
      expect(outcome.result.stderr).not.toContain('synthetic-secret');
      if (stage !== undefined) {
        const line = outcome.result.stderr.split('\n').find(value => value.startsWith('ci-failure-diagnostic:'));
        expect(JSON.parse(line!.slice('ci-failure-diagnostic:'.length)).classification.stage).toBe(stage);
      }
    });
  }

  for (const [kind, reason] of [['checksum', /checksum-mismatch/], ['transport', /remote-state-unknown/]] as const) {
    // contract_id: contract.ci-release-publication-verifier.outputs
    test(`publication entrypoint reports an asset readback ${kind} failure as its own diagnostic`, async (t) => {
      // Arrange
      const { run, afterInputs } = setup(t);
      const inputs = await afterInputs();
      // Act
      const outcome = await run('verify-after', { releases: ['published'], assetFailure: { 0: kind } }, inputs);
      // Assert
      expectRejected(outcome, reason);
      const other = kind === 'checksum' ? /remote-state-unknown/ : /checksum-mismatch/;
      expect(outcome.result.stderr).not.toMatch(other);
    });
  }
});
