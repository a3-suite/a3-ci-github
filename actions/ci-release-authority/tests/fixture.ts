import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { OWNER_HANDOFF_PATH } from '../src/authority';
import { runControl } from '../../ci-release-publication-control/src/control';
import { resolveConfigSnapshot } from '../../ci-config-snapshot/src/snapshot';
import { GithubReadOnlyClient } from '../../../runtime/release-publication/observation';

export const repository = 'owner/product';
export const source = 'b'.repeat(40);
const tagObject = 'c'.repeat(40);
const control = 'a'.repeat(40);
export const fixture = () => {
  const parent = path.resolve(__dirname, '../../../tmp');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'authority-test-'));
  const notes = '# Approved release\n';
  const digest = crypto.createHash('sha256').update(notes).digest('hex');
  const ownerBytes = Buffer.from('name: release-publication-request\non: workflow_dispatch\n');
  fs.mkdirSync(path.dirname(path.join(root, OWNER_HANDOFF_PATH)), { recursive: true });
  fs.writeFileSync(path.join(root, OWNER_HANDOFF_PATH), ownerBytes);
  runControl({ operation: 'create-request', rootDirectory: root, requestWorkflowRunId: '22', requestHeadSha: control, releaseRequestRunId: '11', releaseIdentity: 'v1.2.3', releaseVersion: '1.2.3', targetIdentity: 'platform-set', releaseNotes: notes, approvalId: 'approved', approvalBodySha256: digest, approvalExpiresAt: '2999-01-01T00:00:00Z' });
  fs.mkdirSync(path.join(root, 'release-request'));
  const request = { schema: 'ci.release-request.v1', event: 'tag', ref: 'refs/tags/v1.2.3', tag: 'v1.2.3', source_sha: source, tag_object_sha: tagObject, tag_object_type: 'tag', request_run_id: '11', version: null, version_resolution: 'authority' };
  const requestBytes = JSON.stringify(request);
  fs.writeFileSync(path.join(root, 'release-request/release-request.json'), requestBytes);
  fs.writeFileSync(path.join(root, 'release-request/release-request.json.sha256'), `${crypto.createHash('sha256').update(requestBytes).digest('hex')}  release-request.json\n`);
  const snapshot = resolveConfigSnapshot({ workflow: { CI_RELEASE_OWNER_CONTRACT: 'git.release-flow', CI_RELEASE_IMPLEMENTATION: 'rust-cli-release', CI_LANGUAGE_PROFILE: 'rust', CI_TOOLCHAIN_VERSION: '1.91.1', CI_PLATFORM_MANIFEST: '.ci/platform-manifest.yml', CI_SUPPLEMENTAL_RELEASE_ASSET_ENABLED: 'false' } });
  fs.mkdirSync(path.join(root, '.ci'));
  fs.writeFileSync(path.join(root, '.ci/platform-manifest.yml'), 'platforms:\n  - id: linux\n    runner: ubuntu-24.04\n    target: x86_64-unknown-linux-gnu\n');
  fs.writeFileSync(path.join(root, 'snapshot.json'), JSON.stringify(snapshot));
  const runs = {
    publication: { id: 22, head_sha: control, head_branch: 'main', name: 'release-publication-request', event: 'workflow_dispatch', conclusion: 'success', repository: { full_name: repository }, path: OWNER_HANDOFF_PATH, actor: { login: 'operator' }, triggering_actor: { login: 'operator' } },
    request: { id: 11, head_sha: source, name: 'release-request-tag', event: 'push', conclusion: 'success', repository: { full_name: repository }, path: '.github/workflows/release-request-tag.yml' },
  };
  const responses: Record<string, unknown> = {
    [`/repos/${repository}`]: { full_name: repository, archived: false, disabled: false, default_branch: 'main', permissions: { push: false } },
    [`/repos/${repository}/actions/runs/22`]: runs.publication,
    [`/repos/${repository}/actions/runs/11`]: runs.request,
    [`/repos/${repository}/contents/${OWNER_HANDOFF_PATH}?ref=${control}`]: { type: 'file', encoding: 'base64', content: ownerBytes.toString('base64') },
    [`/repos/${repository}/git/ref/tags/v1.2.3`]: { object: { type: 'tag', sha: tagObject } },
    [`/repos/${repository}/git/tags/${tagObject}`]: { sha: tagObject, tag: 'v1.2.3', object: { type: 'commit', sha: source } },
    [`/repos/${repository}/git/commits/${source}`]: { sha: source },
    [`/repos/${repository}/commits/main`]: { sha: source },
  };
  const requests: string[] = [];
  const client = new GithubReadOnlyClient('test-token', async (url, init) => {
    assert.equal(init?.method, 'GET');
    const endpoint = String(url).replace('https://api.github.com', '');
    requests.push(endpoint);
    return new Response(JSON.stringify(responses[endpoint] ?? {}), { status: 200 });
  });
  const options = { rootDirectory: root, snapshotPath: 'snapshot.json', outputDirectory: path.join(root, 'authority'), repository, requestRunId: '11', publicationRequestRunId: '22' };
  return { root, options, responses, requests, client };
};
