import assert from 'node:assert/strict';
import test from 'node:test';
import { validateReleaseDecision } from '../src/authority';

// integration_id: ci-release-authority-decision
test('accepts explicit owner version and rejects tag-derived or changed decision', () => {
  const request = { schema: 'ci.release-publication-request.v2', releaseVersion: '1.2.3', targetIdentity: 'release-platforms', releaseIdentity: 'v1.2.3' };
  assert.deepEqual(validateReleaseDecision(request), { version: '1.2.3', targetIdentity: 'release-platforms', tag: 'v1.2.3' });
  for (const invalid of [{ ...request, releaseVersion: null }, { ...request, releaseVersion: '1.2.4' }, { ...request, targetIdentity: '' }, { ...request, schema: 'ci.release-publication-request.v1' }]) {
    assert.throws(() => validateReleaseDecision(invalid));
  }
});

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createAuthority, OWNER_HANDOFF_PATH } from '../src/authority';
import { fixture, repository, source } from './fixture';
import { assembleRelease } from '../../../runtime/release-publication/assembly';
import { decodePlatformManifest } from '../../ci-release-assembly/src/platform-manifest-decoder';

// integration_id: ci-release-authority-runtime
test('standard authority binds explicit decision, existing owner workflow, snapshot and GET-only observations', async () => {
  const f = fixture();
  try {
    const result = await createAuthority(f.options, f.client);
    const authority = JSON.parse(fs.readFileSync(result.authorityPath, 'utf8'));
    assert.equal(authority.publication.source_sha, source);
    assert.equal(authority.publication.target_identity, 'platform-set');
    assert.equal(authority.version, '1.2.3');
    assert.equal(authority.owner_contract.id, 'git.release-flow');
    assert.equal(authority.owner_contract_digest.length, 64);
    assert.equal(authority.config_snapshot_digest.length, 64);
    assert.equal(authority.provider_publication_suitability.status, 'source-compatible');
    assert.equal(authority.provider_publication_suitability.write_capability, 'not-observed');
    assert.equal(result.approvalId, 'approved');
    assert.ok(fs.existsSync(path.join(f.root, 'authority/release-notes-approval.json')));
    const build = path.join(f.root, 'build/release-build-linux');
    fs.mkdirSync(build, { recursive: true });
    const name = 'product-1.2.3-linux.tar.gz';
    const payload = Buffer.from('verified build fixture');
    const digest = crypto.createHash('sha256').update(payload).digest('hex');
    fs.writeFileSync(path.join(build, name), payload);
    fs.writeFileSync(path.join(build, `${name}.sha256`), `${digest}  ${name}\n`);
    fs.writeFileSync(path.join(build, 'asset-manifest.json'), JSON.stringify({ schema_version: '1', kind: 'ci-release-build-manifest', source_sha: source, version: '1.2.3', platform_id: 'linux', platform_target: 'x86_64-unknown-linux-gnu', assets: [{ path: name, sha256: digest, checksum_path: `${name}.sha256` }] }));
    const assembled = assembleRelease({ repository, authorityPath: result.authorityPath,
      snapshotPath: path.join(f.root, 'authority/config-snapshot.json'), platformManifestPath: path.join(f.root, '.ci/platform-manifest.yml'),
      platformMatrix: JSON.stringify({ include: [{ id: 'linux', runner: 'ubuntu-24.04', target: 'x86_64-unknown-linux-gnu' }] }),
      buildRoot: path.join(f.root, 'build'), outputRoot: path.join(f.root, 'handoff') }, decodePlatformManifest);
    assert.deepEqual(assembled.identity, authority.publication);

  } finally { fs.rmSync(f.root, { recursive: true }); }
});

// integration_id: ci-release-authority-runtime
test('authority rejects untrusted runs, moved tags, owner drift, snapshot drift and expired approval without authority output', async () => {
  const mutations = [
    (f: ReturnType<typeof fixture>) => { f.responses[`/repos/${repository}/commits/main`] = { sha: 'd'.repeat(40) }; },
    (f: ReturnType<typeof fixture>) => { f.responses[`/repos/${repository}`] = []; },
    (f: ReturnType<typeof fixture>) => { (f.responses[`/repos/${repository}`] as Record<string, unknown>).archived = true; },
    (f: ReturnType<typeof fixture>) => { f.responses[`/repos/${repository}/contents/${OWNER_HANDOFF_PATH}?ref=${'a'.repeat(40)}`] = { type: 'file', encoding: 'base64', content: 'invalid!' }; },
    (f: ReturnType<typeof fixture>) => { fs.mkdirSync(f.options.outputDirectory); fs.writeFileSync(path.join(f.options.outputDirectory, 'owner-file'), 'preserve'); },
    (f: ReturnType<typeof fixture>) => { fs.mkdirSync(path.join(f.root, 'run-metadata')); },

    (f: ReturnType<typeof fixture>) => { delete f.responses[`/repos/${repository}/actions/runs/11`]; },
    (f: ReturnType<typeof fixture>) => { f.responses[`/repos/${repository}/git/tags/${'c'.repeat(40)}`] = { sha: 'c'.repeat(40), tag: 'v1.2.3', object: { type: 'commit', sha: 'd'.repeat(40) } }; },
    (f: ReturnType<typeof fixture>) => { fs.unlinkSync(path.join(f.root, 'release-request/release-request.json')); },
    (f: ReturnType<typeof fixture>) => { (f.responses[`/repos/${repository}/actions/runs/22`] as Record<string, unknown>).conclusion = 'failure'; },
    (f: ReturnType<typeof fixture>) => { (f.responses[`/repos/${repository}/actions/runs/22`] as Record<string, unknown>).head_branch = 'other'; },
    (f: ReturnType<typeof fixture>) => { f.responses[`/repos/${repository}/git/ref/tags/v1.2.3`] = { object: { type: 'tag', sha: 'd'.repeat(40) } }; },
    (f: ReturnType<typeof fixture>) => { fs.appendFileSync(path.join(f.root, OWNER_HANDOFF_PATH), '# changed\n'); },
    (f: ReturnType<typeof fixture>) => { const file = path.join(f.root, 'snapshot.json'); const value = JSON.parse(fs.readFileSync(file, 'utf8')); value.values.CI_TOOLCHAIN_VERSION = 'changed'; fs.writeFileSync(file, JSON.stringify(value)); },
    (f: ReturnType<typeof fixture>) => { const file = path.join(f.root, 'release-publication-request/request.json'); const value = JSON.parse(fs.readFileSync(file, 'utf8')); value.approvalExpiresAt = '2000-01-01T00:00:00Z'; const bytes = JSON.stringify(value); fs.writeFileSync(file, bytes); fs.writeFileSync(`${file}.sha256`, `${crypto.createHash('sha256').update(bytes).digest('hex')}  request.json\n`); },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    try { mutate(f); await assert.rejects(createAuthority(f.options, f.client)); assert.equal(fs.existsSync(path.join(f.options.outputDirectory, 'authority.json')), false);
      const sentinel = path.join(f.options.outputDirectory, 'owner-file');
      if (fs.existsSync(sentinel)) assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserve'); }
    finally { fs.rmSync(f.root, { recursive: true }); }
  }
});

// integration_id: ci-release-authority-runtime
test('authority accepts read-only repository metadata without claiming publish capability and rejects replay', async () => {
  const f = fixture();
  try {
    delete (f.responses[`/repos/${repository}`] as Record<string, unknown>).permissions;
    const result = await createAuthority(f.options, f.client);
    const bytes = fs.readFileSync(result.authorityPath, 'utf8');
    await assert.rejects(createAuthority(f.options, f.client));
    assert.equal(fs.readFileSync(result.authorityPath, 'utf8'), bytes);
  } finally { fs.rmSync(f.root, { recursive: true }); }
});
