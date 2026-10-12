import assert from 'node:assert/strict';
import fs from 'node:fs';

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
    const entries = await request('GET', `/repos/${repository}/releases?per_page=2&page=${page}`);
    assert.ok(Array.isArray(entries), 'probe-list-shape-invalid');
    result.push(...entries);
    if (entries.length < 2) {
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
  const prior = await releases();
  assert.ok(!prior.entries.some(entry => entry.tag_name === tag), 'probe-identity-already-present');
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
  report.status = 'success';
} catch (error) {
  report.status = 'failure';
  const reasons = new Set(['probe-list-shape-invalid', 'probe-list-duplicate', 'probe-list-incomplete',
    'probe-identity-already-present', 'probe-release-id-invalid', 'probe-created-identity-mismatch',
    'probe-direct-id-mismatch', 'probe-direct-tag-mismatch', 'probe-direct-not-draft',
    'probe-draft-not-listed', 'probe-listed-tag-mismatch', 'probe-listed-not-draft']);
  const reason = error instanceof Error ? error.message.split('\n')[0] : '';
  report.reason = reasons.has(reason) ? reason : 'probe-transport-or-response-invalid';
  process.exitCode = 1;
} finally {
  if (createdId) {
    try {
      const owned = await request('GET', `/repos/${repository}/releases/${createdId}`);
      assert.equal(owned.id, createdId, 'probe-cleanup-id-mismatch');
      assert.equal(owned.tag_name, tag, 'probe-cleanup-identity-mismatch');
      assert.equal(owned.draft, true, 'probe-cleanup-not-draft');
      await request('DELETE', `/repos/${repository}/releases/${createdId}`);
      report.cleanup = { release_id: createdId, deleted: true };
    } catch {
      report.cleanup = { release_id: createdId, deleted: false };
      report.reason = 'probe-cleanup-unconfirmed';
      report.status = 'failure';
      process.exitCode = 1;
    }
  }
  fs.mkdirSync('logs', { recursive: true });
  fs.writeFileSync('logs/release-token-capability.json', `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, api_permissions_push: report.api_permissions_push,
    draft: report.draft, cleanup: report.cleanup }));
}
