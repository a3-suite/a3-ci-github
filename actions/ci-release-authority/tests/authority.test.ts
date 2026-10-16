import { describe, test, expect } from 'vitest';
import { validateReleaseDecision } from '../src/authority';

describe('ci-release-authority-decision', () => {
  // integration_id: ci-release-authority-decision
  test('accepts explicit owner version and rejects tag-derived or changed decision', () => {
    const request = { schema: 'ci.release-publication-request.v2', releaseVersion: '1.2.3', targetIdentity: 'release-platforms', releaseIdentity: 'v1.2.3' };
    expect(validateReleaseDecision(request)).toStrictEqual({ version: '1.2.3', targetIdentity: 'release-platforms', tag: 'v1.2.3' });
    for (const invalid of [{ ...request, releaseVersion: null }, { ...request, releaseVersion: '1.2.4' }, { ...request, targetIdentity: '' }, { ...request, schema: 'ci.release-publication-request.v1' }]) {
      expect(() => validateReleaseDecision(invalid)).toThrow();
    }
  });
});

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createAuthority, OWNER_HANDOFF_PATH } from '../src/authority';
import { fixture, repository, source } from './fixture';
import { assembleRelease } from '../../../runtime/release-publication/assembly';
import { decodePlatformManifest } from '../../ci-release-assembly/src/platform-manifest-decoder';
import { resolveConfigSnapshot } from '../../ci-config-snapshot/src/snapshot';
import { FailureContext } from '../../../runtime/diagnostics/failure.mjs';

describe('ci-release-authority-runtime', () => {
  test('authority accepts canonical repository casing while preserving approved identity', async () => {
    const f = fixture();
    try {
      (f.responses[`/repos/${repository}`] as Record<string, unknown>).full_name = repository.toUpperCase();
      for (const id of ['11', '22']) {
        const run = f.responses[`/repos/${repository}/actions/runs/${id}`] as Record<string, unknown>;
        (run.repository as Record<string, unknown>).full_name = repository.toUpperCase();
      }
      const result = await createAuthority(f.options, f.client);
      expect(JSON.parse(fs.readFileSync(result.authorityPath, 'utf8')).publication.repository).toBe(repository);
    } finally { fs.rmSync(f.root, { recursive: true }); }
  });
  test('authority binds LF source identity for CRLF and mixed platform manifests', async () => {
    // Arrange
    for (const endings of ['crlf', 'mixed']) {
      const f = fixture();
      try {
        const filename = path.join(f.root, '.ci/platform-manifest.yml');
        const lf = fs.readFileSync(filename, 'utf8');
        fs.writeFileSync(filename, endings === 'crlf' ? lf.replaceAll('\n', '\r\n') : lf.replace('\n', '\r\n'));
        // Act
        const result = await createAuthority(f.options, f.client);
        const authority = JSON.parse(fs.readFileSync(result.authorityPath, 'utf8'));
        // Assert
        expect(authority.platform_manifest_sha256).toBe(crypto.createHash('sha256').update(lf).digest('hex'));
      } finally { fs.rmSync(f.root, { recursive: true }); }
    }
  });
  // integration_id: ci-release-authority-runtime
  test('standard authority binds explicit decision, existing owner workflow, snapshot and GET-only observations', async () => {
    const f = fixture();
    try {
      const result = await createAuthority(f.options, f.client);
      const authority = JSON.parse(fs.readFileSync(result.authorityPath, 'utf8'));
      expect(authority.publication.source_sha).toBe(source);
      expect(authority.publication.target_identity).toBe('platform-set');
      expect(authority.version).toBe('1.2.3');
      expect(authority.owner_contract.id).toBe('git.release-flow');
      expect(authority.owner_contract_digest.length).toBe(64);
      expect(authority.config_snapshot_digest.length).toBe(64);
      expect(authority.provider_publication_suitability.status).toBe('source-compatible');
      expect(authority.provider_publication_suitability.write_capability).toBe('not-observed');
      expect(result.approvalId).toBe('approved');
      const platformPath = path.join(f.root, '.ci/platform-manifest.yml');
      const platformLf = fs.readFileSync(platformPath, 'utf8').replaceAll('\r\n', '\n');
      expect(authority.platform_manifest_sha256).toBe(crypto.createHash('sha256').update(platformLf).digest('hex'));
      fs.writeFileSync(platformPath, platformLf.replaceAll('\n', '\r\n'));
      expect(fs.existsSync(path.join(f.root, 'authority/release-notes-approval.json'))).toBeTruthy();
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
      expect(assembled.identity).toStrictEqual(authority.publication);

    } finally { fs.rmSync(f.root, { recursive: true }); }
  });

  // integration_id: ci-release-authority-runtime
  test('authority rejects untrusted runs, moved tags, owner drift, snapshot drift and expired approval without authority output', async () => {
    const mutations = [
      (f: ReturnType<typeof fixture>) => { f.responses[`/repos/${repository}/commits/main`] = { sha: 'd'.repeat(40) }; },
      (f: ReturnType<typeof fixture>) => { f.responses[`/repos/${repository}`] = []; },
      (f: ReturnType<typeof fixture>) => { (f.responses[`/repos/${repository}`] as Record<string, unknown>).archived = true; },
      (f: ReturnType<typeof fixture>) => { (f.responses[`/repos/${repository}`] as Record<string, unknown>).full_name = 'another/repository'; },
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
      try { mutate(f); await expect(createAuthority(f.options, f.client)).rejects.toThrow(); expect(fs.existsSync(path.join(f.options.outputDirectory, 'authority.json'))).toBe(false);
        const sentinel = path.join(f.options.outputDirectory, 'owner-file');
        if (fs.existsSync(sentinel)) expect(fs.readFileSync(sentinel, 'utf8')).toBe('preserve'); }
      finally { fs.rmSync(f.root, { recursive: true }); }
    }
  });

  // integration_id: ci-release-authority-runtime
  test('authority rejection retains the failing verification stage and expected/observed identity', async () => {
    // Arrange
    const base = { repository, requestRunId: '11', publicationRequestRunId: '22' };
    const bound = { ...base, tag: 'v1.2.3', source, approvalId: 'approved' };
    const rewrite = (f: ReturnType<typeof fixture>, file: string, change: (value: Record<string, unknown>) => void) => {
      const target = path.join(f.root, file); const value = JSON.parse(fs.readFileSync(target, 'utf8')); change(value); fs.writeFileSync(target, JSON.stringify(value));
    };
    const cases: [string, (f: ReturnType<typeof fixture>) => void, Record<string, unknown>, Record<string, unknown>?][] = [
      ['decision-validation', (f) => rewrite(f, 'release-publication-request/request.json', (value) => { value.schema = { body: 'private-notes-body', credential: 'credential-value' }; }),
        { field: 'schema', expected: 'ci.release-publication-request.v2', observed: 'type:object' }, base],
      ['notes-approval', (f) => { fs.writeFileSync(path.join(f.root, 'release-notes-handoff/release-notes.json'), 'not-json'); }, {}, base],
      ['notes-approval', (f) => { fs.unlinkSync(path.join(f.root, 'release-notes-handoff/release-notes-approval.json')); }, {}, base],
      ['request-provenance', (f) => { (f.responses[`/repos/${repository}/actions/runs/22`] as Record<string, unknown>).conclusion = 'failure'; },
        { field: 'run.conclusion', run: '22', expected: 'success', observed: 'failure' }],
      ['request-provenance', (f) => { (f.responses[`/repos/${repository}/actions/runs/22`] as Record<string, unknown>).head_branch = 'other'; },
        { field: 'run.head_branch', run: '22', expected: 'main', observed: 'other' }],
      ['tag-source', (f) => { f.responses[`/repos/${repository}/git/ref/tags/v1.2.3`] = { object: { type: 'tag', sha: 'd'.repeat(40) } }; },
        { field: 'tag-ref.object', expected: { type: 'tag', sha: 'c'.repeat(40) }, observed: { type: 'tag', sha: 'd'.repeat(40) } }],
      ['workflow-binding', (f) => { fs.appendFileSync(path.join(f.root, OWNER_HANDOFF_PATH), '# changed\n'); },
        { field: 'owner-workflow-sha256' }],
      ['provider-suitability', (f) => { (f.responses[`/repos/${repository}`] as Record<string, unknown>).archived = true; },
        { field: 'repository-metadata', observed: { full_name: repository, archived: true, disabled: false } }],
    ];
    for (const [stage, mutate, comparison, inputs = bound] of cases) {
      const f = fixture();
      try {
        mutate(f);
        const diagnostic = new FailureContext('ci-release-authority', 'release-authority');
        // Act
        const error = await createAuthority(f.options, f.client, diagnostic).then(() => undefined, (failure: unknown) => failure);
        // Assert
        expect(error, stage).toBeDefined();
        const evidence = diagnostic.evidence(error);
        expect(evidence, `${stage} ${String(comparison.field)}`).toMatchObject({ classification: { subject: 'ci-release-authority', stage }, context: { inputs }, comparison });
        expect(JSON.stringify(evidence)).not.toMatch(/private-notes-body|credential-value/);
      } finally { fs.rmSync(f.root, { recursive: true }); }
    }
  });

  // integration_id: ci-release-authority-runtime
  test('authority rejects unsupported implementation, profile and owner with a valid snapshot digest', async () => {
    // Arrange
    for (const [setting, value] of [
      ['CI_RELEASE_IMPLEMENTATION', 'owner-unknown'],
      ['CI_LANGUAGE_PROFILE', 'python'],
      ['CI_RELEASE_OWNER_CONTRACT', 'other-owner'],
    ]) {
      const f = fixture();
      try {
        const snapshotPath = path.join(f.root, 'snapshot.json');
        const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
        const changed = resolveConfigSnapshot({ workflow: { ...snapshot.values, [setting]: value } });
        fs.writeFileSync(snapshotPath, JSON.stringify(changed));
        // Act / Assert
        await expect(createAuthority(f.options, f.client), `${setting}=${value}`).rejects.toThrow('owner-contract-inconsistent');
        expect(fs.existsSync(path.join(f.options.outputDirectory, 'authority.json'))).toBe(false);
      } finally { fs.rmSync(f.root, { recursive: true }); }
    }
  });

  // integration_id: ci-release-authority-runtime
  test('authority accepts read-only repository metadata without claiming publish capability and rejects replay', async () => {
    const f = fixture();
    try {
      delete (f.responses[`/repos/${repository}`] as Record<string, unknown>).permissions;
      const result = await createAuthority(f.options, f.client);
      const bytes = fs.readFileSync(result.authorityPath, 'utf8');
      await expect(createAuthority(f.options, f.client)).rejects.toThrow();
      expect(fs.readFileSync(result.authorityPath, 'utf8')).toBe(bytes);
    } finally { fs.rmSync(f.root, { recursive: true }); }
  });
});
