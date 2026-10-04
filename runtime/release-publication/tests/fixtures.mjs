import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, canonicalJson } from '../io.ts';
import { assembleRelease } from '../assembly.ts';
import { decodePlatformManifest } from '../../../actions/ci-release-assembly/src/platform-manifest-decoder.ts';

export const fixture = (t) => {
  const parent = fileURLToPath(new URL('../../../tests/tmp/', import.meta.url));
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'release-publication-'));
  t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (relative, value) => {
    const filename = path.join(root, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, typeof value === 'string' || Buffer.isBuffer(value) ? value : `${JSON.stringify(value)}\n`);
    return filename;
  };
  const identity = { repository: 'owner/project', tag: 'v1.0.0', tag_object_sha: 'b'.repeat(40), source_sha: 'a'.repeat(40), version: '1.0.0', target_identity: 'owner/project', body_sha256: sha256(Buffer.from('approved notes')) };
  const platform = { id: 'linux', runner: 'ubuntu-24.04', target: 'x86_64-unknown-linux-gnu' };
  const platformManifestPath = put('platform.yml', 'platforms:\n  - id: linux\n    runner: ubuntu-24.04\n    target: x86_64-unknown-linux-gnu\n');
  const values = { CI_SUPPLEMENTAL_RELEASE_ASSET_ENABLED: 'false', CI_PLATFORM_MANIFEST: 'platform.yml' };
  const snapshot = { schema: 'ci.config-snapshot.v1', values, sources: {} };
  snapshot.digest = sha256(Buffer.from(canonicalJson({ sources: snapshot.sources, values })));
  const authority = { publication: identity, source_sha: identity.source_sha, version: identity.version, target_identity: identity.target_identity, platform_manifest: 'platform.yml', platform_manifest_sha256: sha256(fs.readFileSync(platformManifestPath)), config_snapshot_digest: snapshot.digest };
  const payload = Buffer.from('verified archive bytes');
  const name = 'project-1.0.0-linux.tar.gz';
  put(`build/release-build-linux/${name}`, payload);
  put(`build/release-build-linux/${name}.sha256`, `${sha256(payload)}  ${name}\n`);
  const buildManifest = { schema_version: '1', kind: 'ci-release-build-manifest', source_sha: identity.source_sha, version: identity.version, platform_id: platform.id, platform_target: platform.target, assets: [{ path: name, sha256: sha256(payload), checksum_path: `${name}.sha256` }] };
  put('build/release-build-linux/asset-manifest.json', buildManifest);
  const options = { repository: identity.repository, authorityPath: put('authority.json', authority), snapshotPath: put('snapshot.json', snapshot), platformManifestPath, platformMatrix: JSON.stringify({ include: [platform] }), buildRoot: path.join(root, 'build'), outputRoot: path.join(root, 'handoff') };
  return { root, put, identity, authority, snapshot, name, payload, buildManifest, options, assemble: () => assembleRelease(options, decodePlatformManifest) };
};

export const remoteClient = (f, assembly, changes = {}) => {
  const releaseId = changes.releaseId ?? '42';
  const calls = [];
  const client = {
    async json(endpoint) {
      calls.push(['GET', endpoint]);
      if (endpoint.endsWith('/git/ref/tags/v1.0.0')) return { object: { type: 'tag', sha: f.identity.tag_object_sha } };
      if (endpoint.includes('/git/tags/')) return { sha: f.identity.tag_object_sha, object: { type: 'commit', sha: changes.sourceSha ?? f.identity.source_sha } };
      if (endpoint.endsWith(`/releases/${releaseId}`)) return { id: releaseId, tag_name: f.identity.tag, draft: changes.draft ?? false, body: changes.body ?? 'approved notes' };
      return { full_name: f.identity.repository, permissions: { push: changes.push ?? true } };
    },
    async list(endpoint) {
      calls.push(['GET', endpoint]);
      if (endpoint.endsWith('/assets')) return changes.assets ?? assembly.assets.map((asset, index) => ({ id: String(index + 100), name: asset.name, size: asset.size, state: 'uploaded' }));
      return (changes.ids ?? [releaseId]).map((id) => ({ id, tag_name: f.identity.tag, draft: false }));
    },
    async assetDigest(endpoint) {
      calls.push(['GET', endpoint]);
      return changes.digest ?? assembly.assets[Number(endpoint.split('/').at(-1)) - 100].sha256;
    },
  };
  return { client, calls };
};
