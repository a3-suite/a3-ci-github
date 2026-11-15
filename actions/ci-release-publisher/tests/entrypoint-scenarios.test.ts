// flow_id: release-publisher-entrypoint-scenarios
// test_level: e2e
import fs from 'node:fs';
import path from 'node:path';
import { describe, test, expect, type TestContext } from 'vitest';
import { fixture, preObservationFixture, standardPublicationTokenEnvironment } from '../../../runtime/release-publication/tests/fixtures.mjs';

import { actionEntrypointArguments, runActionEntrypoint } from '../../../tests/support/action-entrypoint';

// The preload plays the provider from MOCK_SCENARIO and records every request so that tests can judge writes,
// retries, recovery and prediction requests from the provider boundary alone.
const scenarioFetch = `
import fs from 'node:fs';
import path from 'node:path';
const assembly = JSON.parse(fs.readFileSync(path.join(process.env.MOCK_HANDOFF, 'assembly.json')));
const scenario = JSON.parse(process.env.MOCK_SCENARIO);
let created = false;
let finalized = false;
let uploaded = 0;
let assetInventories = 0;
let releaseInventories = 0;
globalThis.setTimeout = ((nativeSetTimeout) => (callback, _delay, ...args) => nativeSetTimeout(callback, 0, ...args))(globalThis.setTimeout);
globalThis.fetch = async (url, init) => {
  const u = new URL(String(url));
  const endpoint = u.pathname;
  fs.appendFileSync(process.env.MOCK_CALLS, JSON.stringify({ method: init.method, endpoint }) + '\\n');
  const tag = assembly.identity.tag;
  let data;
  let status = 200;
  if (init.method === 'POST' && endpoint.endsWith('/releases')) {
    created = true; status = 201; data = { id: 42, tag_name: tag, draft: true, body: JSON.parse(init.body).body };
  } else if (init.method === 'POST') {
    if (scenario.upload === 'uncertain') return new Response('synthetic-secret', { status: 502 });
    const asset = assembly.assets.find(a => a.name === u.searchParams.get('name'));
    await new Response(init.body).arrayBuffer();
    status = 201; data = { id: 100 + uploaded++, name: asset.name, size: asset.size, state: 'uploaded' };
  } else if (init.method === 'PATCH') {
    finalized = true; data = { id: 42, tag_name: tag, draft: false, body: 'approved notes' };
  } else if (init.method !== 'GET') {
    return new Response('{}', { status: 500 });
  } else if (endpoint.includes('/commits/') || endpoint.includes('/git/trees/')) {
    return new Response('{}', { status: 404 });
  } else if (endpoint.includes('/git/ref/tags/')) data = { object: { type: 'tag', sha: assembly.identity.tag_object_sha } };
  else if (endpoint.includes('/git/tags/')) data = { sha: assembly.identity.tag_object_sha, object: { type: 'commit', sha: scenario.tagCommit ?? assembly.identity.source_sha } };
  else if (endpoint.endsWith('/releases/42/assets')) {
    data = ++assetInventories < (scenario.completeAssetInventory ?? 1) ? [] : assembly.assets.map((a, i) => ({ id: i + 100, name: a.name, size: a.size, state: 'uploaded' }));
  } else if (endpoint.includes('/releases/assets/')) return new Response(fs.readFileSync(path.join(process.env.MOCK_HANDOFF, 'assets', assembly.assets[Number(endpoint.split('/').at(-1)) - 100].name)));
  else if (endpoint.endsWith('/releases/42')) data = { id: 42, tag_name: tag, draft: !finalized, body: 'approved notes' };
  else if (endpoint.endsWith('/releases')) {
    if (++releaseInventories === 1 && scenario.changeHandoffAsset) fs.writeFileSync(scenario.changeHandoffAsset, 'changed during observation');
    data = created ? [{ id: 42, tag_name: tag, draft: !finalized }] : scenario.existingRelease ? [{ id: 9, tag_name: tag, draft: scenario.existingRelease === 'draft' }] : [];
  } else data = { full_name: scenario.repositoryName ?? assembly.identity.repository, permissions: { push: scenario.push ?? true }, default_branch: 'main' };
  return new Response(JSON.stringify(data), { status });
};
`;

type Call = { method: string; endpoint: string };

describe.each(['source', 'dist'] as const)('%s entrypoint', { concurrent: true }, (surface) => {
  const entrypointArgs = actionEntrypointArguments(path.resolve(__dirname, '..'), surface);

  const setup = async (t: TestContext) => {
    const f = fixture(t);
    const assembly = f.assemble();
    const before = preObservationFixture({ authorityPath: f.options.authorityPath, repository: f.identity.repository, handoffRoot: f.options.outputRoot });
    const beforePath = f.put('before.json', before);
    f.put('release-notes.json', { schema: 'ci.release-notes.v1', source_contract: 'git.release-flow', source_field: 'body', release_identity: f.identity.tag, body: 'approved notes', body_sha256: f.identity.body_sha256 });
    f.put('release-notes-approval.json', { schema: 'ci.release-notes-approval.v1', source_contract: 'git.release-flow', source_field: 'body', release_identity: f.identity.tag, body_sha256: f.identity.body_sha256, approval_id: 'approved-1' });
    f.put('publication-request.json', { schema: 'ci.release-publication-request.v2', releaseVersion: f.identity.version, targetIdentity: f.identity.target_identity, approvalId: 'approved-1', approvalExpiresAt: '2099-01-01T00:00:00Z', releaseIdentity: f.identity.tag, releaseNotesBodySha256: f.identity.body_sha256 });
    const mock = f.put('scenario-fetch.mjs', scenarioFetch);
    const output = f.put('github-output', '');
    const calls = f.put('calls.jsonl', '');
    const outputRoot = path.join(f.root, 'write');
    const run = async (scenario: Record<string, unknown> = {}) => {
      const env = { ...process.env, ...standardPublicationTokenEnvironment(f.identity.repository, 'synthetic-secret'), GITHUB_OUTPUT: output, PATH: path.join(f.root, 'no-cli'),
        'INPUT_AUTHORITY-PATH': f.options.authorityPath, 'INPUT_RELEASE-HANDOFF-ROOT': f.options.outputRoot, 'INPUT_PRE-OBSERVATION-PATH': beforePath,
        'INPUT_WRITE-OUTPUT-DIRECTORY': outputRoot, MOCK_HANDOFF: f.options.outputRoot, MOCK_CALLS: calls, MOCK_SCENARIO: JSON.stringify(scenario) };
      const result = await runActionEntrypoint(['--import', mock, ...entrypointArgs], { env, cwd: f.root, encoding: 'utf8' });
      const requests = fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Call);
      const writes = requests.filter(entry => entry.method !== 'GET');
      return { result, outputs: fs.readFileSync(output, 'utf8'), requests, writes };
    };
    return { f, assembly, outputRoot, run };
  };
  const writeKinds = (writes: Call[]) => writes.map(entry => entry.method === 'PATCH' ? 'finalize' : entry.endpoint.endsWith('/releases') ? 'create' : 'upload');
  const expectPublished = (outcome: Awaited<ReturnType<Awaited<ReturnType<typeof setup>>['run']>>, outputRoot: string, assets: number) => {
    expect(outcome.result.status, outcome.result.stderr).toBe(0);
    expect(outcome.outputs).toBe(`receipt-path=${outputRoot}/receipt.json\nreadback-path=${outputRoot}/readback.json\n`);
    expect(writeKinds(outcome.writes)).toStrictEqual(['create', ...Array(assets).fill('upload'), 'finalize']);
    expect(outcome.writes.slice(1).every(entry => entry.endpoint.includes('/releases/42'))).toBe(true);
    expect(fs.readdirSync(outputRoot).sort()).toStrictEqual(['readback.json', 'receipt.json']);
    expect(JSON.parse(fs.readFileSync(path.join(outputRoot, 'receipt.json'), 'utf8')).release_id).toBe('42');
    expect(JSON.parse(fs.readFileSync(path.join(outputRoot, 'readback.json'), 'utf8')).release_id).toBe('42');
    expect(`${outcome.result.stdout}${outcome.result.stderr}${outcome.outputs}`).not.toContain('synthetic-secret');
  };
  const expectRejectedBeforeWrites = (outcome: Awaited<ReturnType<Awaited<ReturnType<typeof setup>>['run']>>, outputRoot: string) => {
    expect(outcome.result.status).toBe(1);
    expect(outcome.outputs).toBe('');
    expect(outcome.writes).toStrictEqual([]);
    expect(fs.existsSync(outputRoot)).toBe(false);
    expect(outcome.result.stderr).not.toContain('synthetic-secret');
  };

  // contract_id: contract.ci-release-publisher.outputs
  test('publisher entrypoint creates once by immutable ID and leaves acceptance to the create response', async (t) => {
    // Arrange
    const { assembly, outputRoot, run } = await setup(t);
    // Act
    const outcome = await run();
    // Assert
    expectPublished(outcome, outputRoot, assembly.assets.length);
    expect(outcome.requests.filter(entry => entry.endpoint.includes('/commits/') || entry.endpoint.includes('/git/trees/'))).toStrictEqual([]);
  });

  // contract_id: contract.ci-release-publisher.outputs
  test('publisher entrypoint publishes with a bound standard workflow token when the API reports push false', async (t) => {
    // Arrange
    const { assembly, outputRoot, run } = await setup(t);
    // Act
    const outcome = await run({ push: false });
    // Assert
    expectPublished(outcome, outputRoot, assembly.assets.length);
  });

  // contract_id: contract.ci-release-publisher.outputs
  test('publisher entrypoint preserves approved identity across canonical repository casing', async (t) => {
    // Arrange
    const { f, assembly, outputRoot, run } = await setup(t);
    // Act
    const outcome = await run({ repositoryName: 'Owner/Project' });
    // Assert
    expectPublished(outcome, outputRoot, assembly.assets.length);
    expect(JSON.parse(fs.readFileSync(path.join(outputRoot, 'receipt.json'), 'utf8')).identity).toStrictEqual(f.identity);
  });

  // contract_id: contract.ci-release-publisher.outputs
  test('publisher entrypoint waits for the uploaded asset inventory without repeating writes', async (t) => {
    // Arrange
    const { assembly, outputRoot, run } = await setup(t);
    // Act
    const outcome = await run({ completeAssetInventory: 3 });
    // Assert
    expectPublished(outcome, outputRoot, assembly.assets.length);
    expect(outcome.requests.filter(entry => entry.method === 'GET' && entry.endpoint.endsWith('/releases/42/assets')).length).toBeGreaterThanOrEqual(3);
  });

  // contract_id: contract.ci-release-publisher.outputs
  test('publisher entrypoint rejects a handoff asset changed during final absence observation before create', async (t) => {
    // Arrange
    const { f, outputRoot, run } = await setup(t);
    // Act
    const outcome = await run({ changeHandoffAsset: path.join(f.options.outputRoot, 'assets', f.name) });
    // Assert
    expectRejectedBeforeWrites(outcome, outputRoot);
    expect(outcome.result.stderr).toMatch(/checksum-mismatch/);
  });

  // contract_id: contract.ci-release-publisher.outputs
  test('publisher entrypoint rejects an expired approval before writes', async (t) => {
    // Arrange
    const { f, outputRoot, run } = await setup(t);
    f.put('publication-request.json', { ...JSON.parse(fs.readFileSync(path.join(f.root, 'publication-request.json'), 'utf8')), approvalExpiresAt: '2000-01-01T00:00:00Z' });
    // Act
    const outcome = await run();
    // Assert
    expectRejectedBeforeWrites(outcome, outputRoot);
    expect(outcome.result.stderr).toMatch(/approval-expired-or-invalid/);
  });

  // contract_id: contract.ci-release-publisher.outputs
  test('publisher entrypoint rejects a tampered handoff asset before writes', async (t) => {
    // Arrange
    const { f, outputRoot, run } = await setup(t);
    f.put(`handoff/assets/${f.name}`, 'changed');
    // Act
    const outcome = await run();
    // Assert
    expectRejectedBeforeWrites(outcome, outputRoot);
    expect(outcome.result.stderr).toMatch(/checksum-mismatch/);
  });

  // contract_id: contract.ci-release-publisher.outputs
  test('publisher entrypoint rejects a moved tag source before writes', async (t) => {
    // Arrange
    const { outputRoot, run } = await setup(t);
    // Act
    const outcome = await run({ tagCommit: 'f'.repeat(40) });
    // Assert
    expectRejectedBeforeWrites(outcome, outputRoot);
    expect(outcome.result.stderr).toMatch(/source-identity-mismatch/);
  });

  // contract_id: contract.ci-release-publisher.outputs
  test('publisher entrypoint refuses to write over an existing same-tag published release', async (t) => {
    // Arrange
    const { outputRoot, run } = await setup(t);
    // Act
    const outcome = await run({ existingRelease: 'published' });
    // Assert
    expectRejectedBeforeWrites(outcome, outputRoot);
    expect(outcome.result.stderr).toMatch(/existing-release-or-asset/);
  });

  // contract_id: contract.ci-release-publisher.outputs
  test('publisher entrypoint stops after an uncertain upload without retry, recovery or delete', async (t) => {
    // Arrange
    const { outputRoot, run } = await setup(t);
    // Act
    const outcome = await run({ upload: 'uncertain' });
    // Assert
    expect(outcome.result.status).toBe(1);
    expect(outcome.outputs).toBe('');
    expect(writeKinds(outcome.writes)).toStrictEqual(['create', 'upload']);
    expect(outcome.writes[1].endpoint).toBe('/repos/owner/project/releases/42/assets');
    expect(outcome.writes.some(entry => entry.method === 'DELETE' || entry.method === 'PATCH')).toBe(false);
    expect(fs.existsSync(path.join(outputRoot, 'receipt.json'))).toBe(false);
    expect(fs.existsSync(path.join(outputRoot, 'readback.json'))).toBe(false);
    expect(outcome.result.stderr).not.toContain('synthetic-secret');
  });
});
