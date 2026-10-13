import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const run = process.env.GITHUB_RUN_ID;
const attempt = process.env.GITHUB_RUN_ATTEMPT;
assert.equal(repository, 'a3-suite/a3-ci-github', 'probe-repository-mismatch');
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'probe-context-mismatch');
assert.equal(process.env.CI_RELEASE_CONTENTS_PERMISSION, 'write', 'probe-permission-mismatch');
assert.equal(process.env.GITHUB_EVENT_NAME, 'workflow_dispatch', 'probe-event-mismatch');
assert.ok(typeof token === 'string' && token.length > 0, 'probe-token-missing');
assert.match(run, /^[1-9][0-9]*$/);
assert.match(attempt, /^[1-9][0-9]*$/);
const tag = `ci-capability-probe-${run}-${attempt}`;
const report = { schema: 'ci.release-token-capability-probe.v1', repository, run, attempt,
  job: process.env.GITHUB_JOB, workflow_ref: process.env.GITHUB_WORKFLOW_REF,
  source_sha: process.env.GITHUB_SHA, event: process.env.GITHUB_EVENT_NAME, contents_permission: 'write',
  credential_binding: 'same-job-github-token-single-client', calls: [], status: 'incomplete' };
let createdId;
let publishedByProbe = false;
let fixtureSourceSha;
let tagCreatedByProbe = false;
let releaseCreateAttempted = false;
async function request(method, endpoint, body) {
  assert.ok(endpoint === `/repos/${repository}` || endpoint.startsWith(`/repos/${repository}/`), 'probe-endpoint-mismatch');
  const response = await fetch(`https://api.github.com${endpoint}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  report.calls.push({ method, endpoint, status: response.status, request_id: response.headers.get('x-github-request-id') });
  assert.ok(response.ok, `probe-http-${response.status}`);
  return response.status === 204 ? undefined : response.json();
}
async function releases() {
  const result = [];
  for (let page = 1; page <= 100; page++) {
    const entries = await request('GET', `/repos/${repository}/releases?per_page=100&page=${page}`);
    assert.ok(Array.isArray(entries), 'probe-list-shape-invalid');
    result.push(...entries);
    if (entries.length < 100) {
      assert.equal(new Set(result.map(entry => entry.id)).size, result.length, 'probe-list-duplicate');
      return { entries: result, pages: page };
    }
  }
  throw new Error('probe-list-incomplete');
}
try {
  const metadata = await request('GET', `/repos/${repository}`);
  report.api_permissions_push = metadata.permissions?.push ?? null;
  const base = await request('GET', `/repos/${repository}/commits/${encodeURIComponent(metadata.default_branch)}`);
  assert.match(base.sha, /^[a-f0-9]{40}$/, 'probe-source-invalid');
  fixtureSourceSha = base.sha;
  report.fixture_source_sha = base.sha;
  const prior = await releases();
  assert.ok(!prior.entries.some(entry => entry.tag_name === tag), 'probe-identity-already-present');
  const priorTags = await request('GET', `/repos/${repository}/git/matching-refs/tags/${encodeURIComponent(tag)}`);
  assert.ok(Array.isArray(priorTags), 'probe-tag-inventory-invalid');
  assert.equal(priorTags.length, 0, 'probe-tag-already-present');
  const createdTag = await request('POST', `/repos/${repository}/git/refs`, { ref: `refs/tags/${tag}`, sha: fixtureSourceSha });
  assert.equal(report.calls.at(-1).status, 201, 'probe-tag-create-unconfirmed');
  assert.ok(createdTag.ref === `refs/tags/${tag}` && createdTag.object?.type === 'commit' && createdTag.object?.sha === fixtureSourceSha, 'probe-tag-create-invalid');
  tagCreatedByProbe = true;
  report.tag_ownership = { tag, absent_before_create: true, created_by_probe: true, source_sha: fixtureSourceSha };
  releaseCreateAttempted = true;
  const draft = await request('POST', `/repos/${repository}/releases`, {
    tag_name: tag, target_commitish: base.sha, name: tag, body: 'Isolated provider capability verification.', draft: true,
  });
  assert.ok(Number.isSafeInteger(draft.id) && draft.id > 0, 'probe-release-id-invalid');
  createdId = draft.id;
  assert.equal(draft.tag_name, tag, 'probe-created-identity-mismatch');
  const direct = await request('GET', `/repos/${repository}/releases/${createdId}`);
  assert.equal(direct.id, createdId, 'probe-direct-id-mismatch');
  assert.equal(direct.tag_name, tag, 'probe-direct-tag-mismatch');
  assert.equal(direct.draft, true, 'probe-direct-not-draft');
  report.draft = { id: createdId, tag, get_by_id: true, full_list: false, matched_ids: null, pages: null, observations: 0 };
  let inventory;
  let listed;
  for (let observation = 1; observation <= 3; observation++) {
    inventory = await releases();
    listed = inventory.entries.filter(entry => entry.id === createdId);
    report.draft = { id: createdId, tag, get_by_id: true, full_list: listed.length === 1,
      matched_ids: listed.length, pages: inventory.pages, observations: observation };
    if (listed.length > 0) break;
    if (observation < 3) await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.equal(listed.length, 1, 'probe-draft-not-listed');
  assert.equal(listed[0].tag_name, tag, 'probe-listed-tag-mismatch');
  assert.equal(listed[0].draft, true, 'probe-listed-not-draft');
  report.observed_write_access = true;
  const tagBeforePublication = await request('GET', `/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`);
  assert.ok(tagBeforePublication.object?.type === 'commit' && tagBeforePublication.object?.sha === fixtureSourceSha, 'probe-prepublish-tag-source-mismatch');
  const beforePublication = await request('GET', `/repos/${repository}/releases/${createdId}`);
  assert.equal(beforePublication.id, createdId, 'probe-prepublish-id-mismatch');
  assert.equal(beforePublication.tag_name, tag, 'probe-prepublish-tag-mismatch');
  assert.equal(beforePublication.draft, true, 'probe-prepublish-state-mismatch');
  const payload = Buffer.from('standard-token-release-capability\n');
  const uploaded = await fetch(`https://uploads.github.com/repos/${repository}/releases/${createdId}/assets?name=capability.txt`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream',
      'x-github-api-version': '2022-11-28' }, body: payload,
  });
  report.calls.push({ method: 'POST', host: 'uploads.github.com', endpoint: `/repos/${repository}/releases/${createdId}/assets`, status: uploaded.status,
    request_id: uploaded.headers.get('x-github-request-id') });
  assert.equal(uploaded.status, 201, 'probe-asset-upload-failed');
  const asset = await uploaded.json();
  assert.ok(Number.isSafeInteger(asset.id) && asset.id > 0, 'probe-asset-id-invalid');
  assert.equal(asset.name, 'capability.txt', 'probe-asset-name-mismatch');
  assert.equal(asset.size, payload.length, 'probe-asset-size-mismatch');
  const published = await request('PATCH', `/repos/${repository}/releases/${createdId}`, { draft: false, prerelease: true, make_latest: 'false' });
  assert.equal(published.id, createdId, 'probe-published-id-mismatch');
  assert.equal(published.tag_name, tag, 'probe-published-tag-mismatch');
  assert.equal(published.draft, false, 'probe-published-state-mismatch');
  publishedByProbe = true;
  const independent = await request('GET', `/repos/${repository}/releases/${createdId}`);
  assert.equal(independent.id, createdId, 'probe-readback-id-mismatch');
  assert.equal(independent.tag_name, tag, 'probe-readback-tag-mismatch');
  assert.equal(independent.draft, false, 'probe-readback-state-mismatch');
  const assets = await request('GET', `/repos/${repository}/releases/${createdId}/assets`);
  assert.ok(Array.isArray(assets) && assets.length === 1 && assets[0].id === asset.id, 'probe-readback-assets-mismatch');
  const assetEndpoint = `/repos/${repository}/releases/assets/${asset.id}`;
  let bytes = await fetch(`https://api.github.com${assetEndpoint}`, {
    redirect: 'manual', signal: AbortSignal.timeout(30000),
    headers: { authorization: `Bearer ${token}`, accept: 'application/octet-stream', 'x-github-api-version': '2022-11-28' },
  });
  report.calls.push({ method: 'GET', endpoint: assetEndpoint, status: bytes.status, request_id: bytes.headers.get('x-github-request-id') });
  if (bytes.status === 302) {
    const location = new URL(bytes.headers.get('location'));
    assert.ok(location.protocol === 'https:' && location.hostname === 'release-assets.githubusercontent.com' && !location.username && !location.password && !location.port, 'probe-readback-redirect-invalid');
    bytes = await fetch(location, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  }
  assert.equal(bytes.status, 200, 'probe-asset-readback-failed');
  const digest = value => createHash('sha256').update(value).digest('hex');
  const received = Buffer.from(await bytes.arrayBuffer());
  assert.equal(received.length, payload.length, 'probe-readback-size-mismatch');
  assert.equal(digest(received), digest(payload), 'probe-readback-checksum-mismatch');
  report.publication = { release_id: createdId, asset_id: asset.id, sha256: digest(received), size: received.length,
    created: true, uploaded: true, published: true, independent_readback: true };
  report.status = 'success';
} catch (error) {
  report.status = 'failure';
  const reasons = new Set(['probe-list-shape-invalid', 'probe-list-duplicate', 'probe-list-incomplete',
    'probe-identity-already-present', 'probe-release-id-invalid', 'probe-created-identity-mismatch',
    'probe-direct-id-mismatch', 'probe-direct-tag-mismatch', 'probe-direct-not-draft',
    'probe-draft-not-listed', 'probe-listed-tag-mismatch', 'probe-listed-not-draft',
    'probe-tag-inventory-invalid', 'probe-tag-already-present', 'probe-tag-create-unconfirmed', 'probe-tag-create-invalid', 'probe-prepublish-tag-source-mismatch',
    'probe-source-invalid', 'probe-prepublish-id-mismatch', 'probe-prepublish-tag-mismatch', 'probe-prepublish-state-mismatch',
    'probe-asset-upload-failed', 'probe-asset-id-invalid', 'probe-asset-name-mismatch', 'probe-asset-size-mismatch',
    'probe-published-id-mismatch', 'probe-published-tag-mismatch', 'probe-published-state-mismatch',
    'probe-readback-id-mismatch', 'probe-readback-tag-mismatch', 'probe-readback-state-mismatch', 'probe-readback-assets-mismatch',
    'probe-readback-redirect-invalid', 'probe-asset-readback-failed', 'probe-readback-size-mismatch', 'probe-readback-checksum-mismatch']);
  const reason = error instanceof Error ? error.message.split('\n')[0] : '';
  report.reason = reasons.has(reason) ? reason : 'probe-transport-or-response-invalid';
  process.exitCode = 1;
} finally {
  if (createdId) {
    try {
      const owned = await request('GET', `/repos/${repository}/releases/${createdId}`);
      assert.equal(owned.id, createdId, 'probe-cleanup-id-mismatch');
      assert.equal(owned.tag_name, tag, 'probe-cleanup-identity-mismatch');
      assert.equal(owned.draft, !publishedByProbe, 'probe-cleanup-state-mismatch');
      if (tagCreatedByProbe) {
        const ownedRef = await request('GET', `/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`);
        assert.ok(ownedRef.object?.type === 'commit' && ownedRef.object?.sha === fixtureSourceSha, 'probe-cleanup-tag-mismatch');
      }
      await request('DELETE', `/repos/${repository}/releases/${createdId}`);
      report.cleanup = { release_id: createdId, deleted: true };

    } catch {
      report.cleanup = { release_id: createdId, deleted: report.cleanup?.deleted === true };
      report.reason = 'probe-cleanup-unconfirmed';
      report.status = 'failure';
      process.exitCode = 1;
    }
  }
  if (tagCreatedByProbe && (!releaseCreateAttempted || report.cleanup?.deleted === true)) {
    try {
      const ref = await request('GET', `/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`);
      assert.ok(ref.object?.type === 'commit' && ref.object?.sha === fixtureSourceSha, 'probe-cleanup-tag-mismatch');
      await request('DELETE', `/repos/${repository}/git/refs/tags/${encodeURIComponent(tag)}`);
      report.tag_cleanup = { tag, deleted: true };
    } catch {
      report.tag_cleanup = { tag, deleted: false };
      report.reason = 'probe-tag-cleanup-unconfirmed';
      report.status = 'failure';
      process.exitCode = 1;
    }
  } else if (tagCreatedByProbe) report.tag_cleanup = { tag, deleted: false };
  fs.mkdirSync('logs', { recursive: true });
  fs.writeFileSync('logs/release-token-capability.json', `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, api_permissions_push: report.api_permissions_push,
    draft: report.draft, cleanup: report.cleanup }));
}
