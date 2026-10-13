import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sha256, canonicalJson } from '../io.ts';
import { assembleRelease } from '../assembly.ts';
import { decodePlatformManifest } from '../../../actions/ci-release-assembly/src/platform-manifest-decoder.ts';

export const standardPublicationTokenEnvironment = (repository, token) => ({
  GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_run', GITHUB_REPOSITORY: repository,
  GITHUB_REF: 'refs/heads/main',
  GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/release-publication-caller.yml@refs/heads/main`,
  CI_RELEASE_CREDENTIAL_SOURCE: 'standard-workflow-github-token', CI_RELEASE_CONTENTS_PERMISSION: 'write',
  GITHUB_TOKEN: token, GH_TOKEN: token,
});

export const fixture = (t, platform = { id: 'linux', runner: 'ubuntu-24.04', target: 'x86_64-unknown-linux-gnu' }) => {
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
  const platformManifestPath = put('platform.yml', `platforms:\n  - id: ${platform.id}\n    runner: ${platform.runner}\n    target: ${platform.target}\n`);
  const values = { CI_SUPPLEMENTAL_RELEASE_ASSET_ENABLED: 'false', CI_PLATFORM_MANIFEST: 'platform.yml' };
  const snapshot = { schema: 'ci.config-snapshot.v1', values, sources: {} };
  snapshot.digest = sha256(Buffer.from(canonicalJson({ sources: snapshot.sources, values })));
  const authority = { publication: identity, source_sha: identity.source_sha, version: identity.version, target_identity: identity.target_identity, platform_manifest: 'platform.yml', platform_manifest_sha256: sha256(fs.readFileSync(platformManifestPath)), config_snapshot_digest: snapshot.digest };
  const payload = Buffer.from('verified archive bytes');
  const name = `project-1.0.0-${platform.id}.${platform.target.includes('-windows-') ? 'zip' : 'tar.gz'}`;
  put(`build/release-build-${platform.id}/${name}`, payload);
  put(`build/release-build-${platform.id}/${name}.sha256`, `${sha256(payload)}  ${name}\n`);
  const buildManifest = { schema_version: '1', kind: 'ci-release-build-manifest', source_sha: identity.source_sha, version: identity.version, platform_id: platform.id, platform_target: platform.target, assets: [{ path: name, sha256: sha256(payload), checksum_path: `${name}.sha256` }] };
  put(`build/release-build-${platform.id}/asset-manifest.json`, buildManifest);
  const options = { repository: identity.repository, authorityPath: put('authority.json', authority), snapshotPath: put('snapshot.json', snapshot), platformManifestPath, platformMatrix: JSON.stringify({ include: [platform] }), buildRoot: path.join(root, 'build'), outputRoot: path.join(root, 'handoff') };
  return { root, put, identity, authority, snapshot, name, payload, buildManifest, options, assemble: () => assembleRelease(options, decodePlatformManifest) };
};

export const releaseSkillsFixture = (t, mutate = () => {}, mutateIndex = () => {}) => {
  const f = fixture(t);
  const configuration = { schemaVersion: 'ci.release-skills.v1', skills: [{ path: 'skills/example-tool', include: ['SKILL.md', 'references', 'scripts', 'assets'], requiredFiles: ['SKILL.md', 'references/setup.guide.md', 'scripts/run.py'] }] };
  f.put('skills/example-tool/SKILL.md', '---\nname: example-tool\ndescription: Read the product using its public CLI.\n---\nRead `references/setup.guide.md` and use `scripts/run.py`.\n');
  f.put('skills/example-tool/references/setup.guide.md', '# Setup\n');
  f.put('skills/example-tool/scripts/run.py', 'raise RuntimeError("skill source must not execute while packaging")\n');
  f.put('skills/example-tool/scripts/__init__.py', '');
  f.put('skills/example-tool/scripts/_helper.py', 'print("public helper")\n');
  f.put('skills/example-tool/scripts/runtime.js', 'throw new Error("public runtime retained");\n');
  f.put('skills/example-tool/assets/example.txt', 'example\n');
  for (const name of ['_build/notes.md', 'tmp/work.py', 'tests/test.py', 'scripts/__pycache__/run.pyc', 'scripts/runtime.js.map', 'scripts/compiler.tsbuildinfo', 'assets/target/output.obj', 'assets/notes.log', 'assets/.DS_Store', 'references/_build/draft.md', 'scripts/tmp/residual.py', 'scripts/tests/test_runtime.py']) f.put(`skills/example-tool/${name}`, 'not public\n');
  f.put('skills/unselected/SKILL.md', 'not selected');
  mutate(configuration, f.root);
  f.put('skills/release.json', configuration);
  const git = (args) => execFileSync('git', ['-C', f.root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  git(['init', '-q']);
  git(['config', 'user.name', 'Fixture']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  git(['config', 'core.autocrlf', 'false']);
  git(['add', '-f', '--', 'skills']);
  git(['update-index', '--chmod=+x', 'skills/example-tool/scripts/run.py']);
  mutateIndex(git);
  git(['commit', '-qm', 'Fixture']);
  const sourceSha = git(['rev-parse', 'HEAD']);
  f.identity.source_sha = sourceSha;
  f.authority.source_sha = sourceSha;
  f.buildManifest.source_sha = sourceSha;
  f.snapshot.values.CI_RELEASE_SKILLS_CONFIG_PATH = 'skills/release.json';
  f.snapshot.digest = sha256(Buffer.from(canonicalJson({ sources: f.snapshot.sources, values: f.snapshot.values })));
  f.authority.config_snapshot_digest = f.snapshot.digest;
  f.put('snapshot.json', f.snapshot);
  f.put('authority.json', f.authority);
  f.put('build/release-build-linux/asset-manifest.json', f.buildManifest);
  f.options.skillsSourceRoot = f.root;
  f.put('skills/example-tool/tmp/untracked.py', 'untracked residual');
  return f;
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
