import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { describe, test, expect } from 'vitest';
import { fixture, standardPublicationTokenEnvironment } from '../../../runtime/release-publication/tests/fixtures.mjs';
import { LIMITS } from '../../../runtime/release-publication/io';

import { actionEntrypointArguments, runActionEntrypoint } from '../../../tests/support/action-entrypoint';

describe.each(['source', 'dist'] as const)('%s entrypoint', { concurrent: true }, (surface) => {
  const entrypointArgs = actionEntrypointArguments(path.resolve(__dirname, '..'), surface);
const bundle = entrypointArgs;
const hash = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');

describe('runActionEntrypoint', () => {

// contract_id: contract.ci-release-publication-verifier.outputs
// flow_id: release-publication-verifier-entrypoint
test('publication entrypoint observes absence then verifies owner evidence independently', async (t) => {
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
  const beforeResult = await runActionEntrypoint(['--import', mock, ...bundle], { env, encoding: 'utf8', cwd: f.root });
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
  const afterResult = await runActionEntrypoint(['--import', mock, ...bundle], { env: { ...env, INPUT_OPERATION: 'verify-after', 'INPUT_RECEIPT-PATH': receiptPath, 'INPUT_READBACK-PATH': readbackPath, MOCK_PHASE: 'after' }, encoding: 'utf8', cwd: f.root });
  expect(afterResult.status, afterResult.stderr).toBe(0);
  const outputs = fs.readFileSync(output, 'utf8');
  expect(outputs).toMatch(/^status=success\n/);
  expect(outputs.includes('observation-path=')).toBe(false);
  expect(outputs.includes('observation-digest=')).toBe(false);
  expect(outputs).toMatch(/release-remote-identity=42\n/);
  expect(outputs).toMatch(/publish-receipt=\{/);
  expect(outputs).toMatch(/readback-evidence=\{/);
  const values = Object.fromEntries(outputs.trim().split('\n')
    .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  expect(JSON.parse(values['publish-receipt']).release_id).toBe('42');
  expect(JSON.parse(values['readback-evidence']).release_id).toBe('42');
  expect(outputs.includes('synthetic-secret')).toBe(false);
});

// contract_id: contract.ci-release-publication-verifier.outputs
// flow_id: release-publication-output-injection-rejection
test('publication entrypoint rejects output path line injection before remote observation', async (t) => {
  const f = fixture(t);
  f.assemble();
  const output = f.put('github-output', '');
  const result = await runActionEntrypoint([...bundle], {
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
// flow_id: release-publication-verifier-entrypoint-rejection
test('publication entrypoint refuses missing credentials without success evidence', async (t) => {
  const f = fixture(t);
  f.assemble();
  const output = f.put('github-output', '');
  const result = await runActionEntrypoint([...bundle], { env: { ...process.env, GH_TOKEN: '', GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output, INPUT_OPERATION: 'observe-before', INPUT_REPOSITORY: f.options.repository, 'INPUT_AUTHORITY-PATH': f.options.authorityPath, 'INPUT_HANDOFF-ROOT': f.options.outputRoot, 'INPUT_OBSERVATION-PATH': path.join(f.root, 'before.json') }, encoding: 'utf8', cwd: f.root });
  expect(result.status).toBe(1);
  expect(fs.readFileSync(output, 'utf8')).toBe('');
  expect(result.stderr).toMatch(/credential-missing/);
});

// contract_id: contract.ci-release-publication-verifier.outputs
// flow_id: release-publication-safe-diagnostics
  const cases: Array<[string, string, Record<string, string>, number]> = [
    ['metadata-absent', 'absent', {}, 0], ['metadata-empty', 'empty', {}, 0],
    ['source-mismatch', 'absent', { CI_RELEASE_CREDENTIAL_SOURCE: 'other-caller' }, 1],
    ['contents-read', 'absent', { CI_RELEASE_CONTENTS_PERMISSION: 'read' }, 1],
    ['token-mismatch', 'absent', { GITHUB_TOKEN: 'another-synthetic-secret' }, 1],
    ['repository-mismatch', 'absent', { GITHUB_REPOSITORY: 'another/project' }, 1],
    ['workflow-path-mismatch', 'absent', { GITHUB_WORKFLOW_REF: 'owner/project/.github/workflows/custom.yml@refs/heads/main' }, 1],
    ['workflow-ref-case', 'absent', { GITHUB_WORKFLOW_REF: 'owner/project/.github/workflows/release-publication-caller.yml@refs/heads/Main' }, 1],
    ['pull-request', 'absent', { GITHUB_EVENT_NAME: 'pull_request' }, 1],
    ['workflow-dispatch', 'absent', { GITHUB_EVENT_NAME: 'workflow_dispatch' }, 1],
    ['metadata-false-bound', 'denied', {}, 0],
    ['metadata-false-read', 'denied', { CI_RELEASE_CONTENTS_PERMISSION: 'read' }, 1],
    ['metadata-false-token-mismatch', 'denied', { GITHUB_TOKEN: 'another-synthetic-secret' }, 1],
    ['metadata-malformed', 'malformed', {}, 1],
  ];
  for (const [label, metadata, context, expectedStatus] of cases) {
    // contract_id: contract.ci-release-publication-verifier.outputs
    // flow_id: release-publication-safe-diagnostics
    test(`publication entrypoint binds standard workflow credential evidence before observing absence: ${label}`, async (t) => {
    const f = fixture(t);
    f.assemble();
    const output = f.put('github-output', '');
    const before = path.join(f.root, 'before.json');
    const mock = f.put('capability-fetch.mjs', `
globalThis.fetch = async (url, init) => {
  if (init.method !== 'GET') throw new Error('write-forbidden');
  const endpoint = new URL(String(url)).pathname;
  if (endpoint.includes('/git/ref/tags/')) return Response.json({ object: { type: 'tag', sha: '${f.identity.tag_object_sha}' } });
  if (endpoint.includes('/git/tags/')) return Response.json({ sha: '${f.identity.tag_object_sha}', object: { type: 'commit', sha: '${f.identity.source_sha}' } });
  if (endpoint.endsWith('/releases')) return Response.json([]);
  const metadata = process.env.MOCK_METADATA;
  return Response.json({ full_name: 'owner/project', ...(metadata === 'empty' ? { permissions: {} }
    : metadata === 'denied' ? { permissions: { push: false } }
    : metadata === 'malformed' ? { permissions: { push: 'synthetic-secret' } } : {}) });
};`);
    const result = await runActionEntrypoint(['--import', mock, ...bundle], { env: {
      ...process.env, ...standardPublicationTokenEnvironment(f.identity.repository, 'synthetic-secret'),
      ...context,
      GITHUB_OUTPUT: output, INPUT_OPERATION: 'observe-before', INPUT_REPOSITORY: f.identity.repository,
      'INPUT_AUTHORITY-PATH': f.options.authorityPath, 'INPUT_HANDOFF-ROOT': f.options.outputRoot,
      'INPUT_OBSERVATION-PATH': before, MOCK_METADATA: metadata,
    }, cwd: f.root, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(expectedStatus);
    if (expectedStatus === 0) {
      expect(JSON.parse(fs.readFileSync(before, 'utf8')).release_ids).toEqual([]);
      expect(fs.readFileSync(output, 'utf8')).toContain('status=success');
    } else {
      expect(fs.existsSync(before)).toBe(false);
      expect(fs.readFileSync(output, 'utf8')).toBe('');
      const reason = metadata === 'denied' ? 'push-permission-denied' : metadata === 'malformed' ? 'push-permission-invalid' : 'permissions-missing';
      expect(result.stderr).toContain(`"sanitized-reason":"${reason}"`);
    }
    expect(`${result.stdout}${result.stderr}${fs.readFileSync(output, 'utf8')}`).not.toContain('synthetic-secret');
    });
  }

// contract_id: contract.ci-release-publication-verifier.outputs
// flow_id: release-publication-safe-diagnostics
for (const [failure, reason, phase] of [
  ['network', 'network-failed', 'request'], ['timeout', 'request-timeout', 'request'],
  ['body-timeout', 'request-timeout', 'response'],
  ['http', 'provider-read-failed', 'request'], ['json', 'response-invalid-json', 'response'],
  ['empty', 'response-empty', 'response'], ['oversized', 'response-too-large', 'response'],
  ['permissions', 'permissions-missing', 'repository'], ['push-missing', 'push-permission-missing', 'repository'],
  ['push-denied', 'push-permission-denied', 'repository'], ['push-invalid', 'push-permission-invalid', 'repository'],
  ['repository', 'repository-identity-mismatch', 'repository'],
  ['inventory', 'response-shape-invalid', 'inventory'], ['duplicate', 'inventory-duplicate-id', 'inventory'],
  ['pagination', 'pagination-limit', 'inventory'],
]) test(`publication entrypoint exposes safe diagnostics for ${failure}`, async (t) => {
  for (const httpStatus of failure === 'http' ? [401, 403, 404, 429, 500, 503] : [403]) {
    const f = fixture(t);
    f.assemble();
    const output = f.put('github-output', '');
    const callsPath = f.put('fetch-calls.jsonl', '');
    const mock = f.put('diagnostic-fetch.mjs', `
import fs from 'node:fs';
const kind = process.env.MOCK_FAILURE;
globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    fs.appendFileSync(process.env.MOCK_CALLS, JSON.stringify({ method: init.method, endpoint: parsed.pathname }) + '\\n');
    if (init.method !== 'GET') throw new Error('write-forbidden');
    const endpoint = parsed.pathname;
    if (endpoint.includes('/git/ref/tags/')) return Response.json({ object: { type: 'tag', sha: '${f.identity.tag_object_sha}' } });
    if (endpoint.includes('/git/tags/')) return Response.json({ sha: '${f.identity.tag_object_sha}', object: { type: 'commit', sha: '${f.identity.source_sha}' } });
    const headers = { 'x-github-request-id': 'safe:123' };
    if (kind === 'network') throw new Error('synthetic-secret');
    if (kind === 'timeout') throw new DOMException('synthetic-secret', 'TimeoutError');
    if (kind === 'body-timeout') return new Response(new ReadableStream({ start(controller) { controller.error(new DOMException('synthetic-secret', 'TimeoutError')); } }), { headers });
    if (kind === 'http') return new Response('synthetic-secret', { status: Number(process.env.MOCK_HTTP_STATUS), headers });
    if (kind === 'json') return new Response('synthetic-secret', { headers });
    if (kind === 'empty') return new Response(null, { headers });
    if (kind === 'oversized') return new Response('x'.repeat(4 * 1024 * 1024 + 1), { headers });
    if (endpoint.endsWith('/releases')) {
      if (kind === 'inventory') return Response.json({ secret: 'synthetic-secret' }, { headers });
      if (kind === 'duplicate') return Response.json([{ id: 42 }, { id: 42 }], { headers });
      const page = Number(new URL(String(url)).searchParams.get('page'));
      return Response.json(Array.from({ length: 100 }, (_, i) => ({ id: (page - 1) * 100 + i + 1 })), { headers });
    }
    const repository = { full_name: 'owner/project', permissions: { push: true } };
    if (kind === 'permissions') delete repository.permissions;
    if (kind === 'push-missing') repository.permissions = {};
    if (kind === 'push-denied') repository.permissions.push = false;
    if (kind === 'push-invalid') repository.permissions.push = 'synthetic-secret';
    if (kind === 'repository') repository.full_name = 'synthetic-secret';
    return Response.json(repository, { headers });
  };`);
    const result = await runActionEntrypoint(['--import', mock, ...bundle], { env: {
      ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output, GH_TOKEN: 'synthetic-secret',
      INPUT_OPERATION: 'observe-before', INPUT_REPOSITORY: f.options.repository,
      'INPUT_AUTHORITY-PATH': f.options.authorityPath, 'INPUT_HANDOFF-ROOT': f.options.outputRoot,
      'INPUT_OBSERVATION-PATH': path.join(f.root, 'before.json'), MOCK_FAILURE: failure,
      MOCK_HTTP_STATUS: String(httpStatus), MOCK_CALLS: callsPath,
    }, cwd: f.root, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(fs.readFileSync(output, 'utf8')).toBe('');
    expect(fs.existsSync(path.join(f.root, 'before.json'))).toBe(false);
    expect(result.stderr).not.toContain('synthetic-secret');
    const diagnostic = JSON.parse(result.stderr.split('\n').find((line: string) => line.startsWith('remote-state-unknown:'))!.slice('remote-state-unknown:'.length));
    expect(diagnostic.operation).toBe('remote-observation');
    expect(diagnostic.phase).toBe(phase);
    expect(diagnostic['sanitized-reason']).toBe(reason);
    expect(diagnostic.method).toBe('GET');
    expect(diagnostic['sanitized-endpoint']).toBe(`/repos/owner/project${phase === 'inventory' ? '/releases' : ''}`);
    expect(diagnostic['http-status']).toBe(failure === 'http' ? httpStatus : ['network', 'timeout'].includes(failure) ? 'unavailable' : 200);
    expect(diagnostic['request-id']).toBe(['network', 'timeout'].includes(failure) ? 'unavailable' : 'safe:123');
    const evidence = JSON.parse(result.stderr.split('\n').find((line: string) => line.startsWith('ci-failure-diagnostic:'))!.slice('ci-failure-diagnostic:'.length));
    expect(evidence.classification.subject).toBe('ci-release-publication-verifier');
    expect(evidence.comparison['http-status']).toBe(diagnostic['http-status']);
    expect(evidence.comparison['request-id']).toBe(diagnostic['request-id']);
    expect(evidence['execution-state'].write).toBe('not-started');
    const calls = fs.readFileSync(callsPath, 'utf8').trim().split('\n').map((line: string) => JSON.parse(line) as { method: string; endpoint: string });
    expect(calls.every(call => call.method === 'GET')).toBe(true);
    expect(calls.slice(0, 3).map(call => call.endpoint)).toEqual([
      `/repos/owner/project/git/ref/tags/${f.identity.tag}`,
      `/repos/owner/project/git/tags/${f.identity.tag_object_sha}`,
      '/repos/owner/project',
    ]);
    const inventoryRequests = phase === 'inventory' ? failure === 'pagination' ? LIMITS.pages : 1 : 0;
    expect(calls.slice(3).map(call => call.endpoint)).toEqual(Array(inventoryRequests).fill('/repos/owner/project/releases'));
  }
});

});
});
