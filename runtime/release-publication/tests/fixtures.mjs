import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Synchronous child processes block the worker, so Vitest's testTimeout cannot interrupt them; bound each call.
// Measured max 0.18s per git call; the limit is the 5s floor that absorbs process start-up jitter. A timeout means the call
// regressed: investigate its performance or split it before raising the limit.
const gitTimeoutMs = 5000;
import { sha256, canonicalJson } from '../io.ts';
import { assembleRelease } from '../assembly.ts';
import { loadAssembly } from '../observation.ts';
import { validateEvidence } from '../schema.ts';
import { decodePlatformManifest } from '../../../actions/ci-release-assembly/src/platform-manifest-decoder.ts';

export const standardPublicationTokenEnvironment = (repository, token) => ({
  GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_run', GITHUB_REPOSITORY: repository,
  GITHUB_REF: 'refs/heads/main',
  GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/release-publication-caller.yml@refs/heads/main`,
  CI_RELEASE_CREDENTIAL_SOURCE: 'standard-workflow-github-token', CI_RELEASE_CONTENTS_PERMISSION: 'write',
  GITHUB_TOKEN: token, GH_TOKEN: token,
});

// Use only when pre-create observation is setup rather than the behavior under test.
export const preObservationFixture = (options) => {
  const { identity, handoffDigest } = loadAssembly(options);
  return validateEvidence('observation', { schema_version: '1', kind: 'ci-github-release-observation', identity, handoff_digest: handoffDigest,
    phase: 'pre-create', complete: true, visibility: 'public-and-non-public', release_ids: [] });
};

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

export const releaseSkillsFixture = (t, mutate = () => {}, mutateIndex = () => {}, configPath = '.ci/release-skills.json') => {
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
  f.put(configPath, configuration);
  const git = (args, input) => execFileSync('git', ['-C', f.root, ...args], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: gitTimeoutMs }).trim();
  git(['init', '-q']);
  git(['config', 'user.name', 'Fixture']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  git(['config', 'core.autocrlf', 'false']);
  git(['add', '-f', '--', '.']);
  git(['update-index', '--chmod=+x', 'skills/example-tool/scripts/run.py']);
  mutateIndex(git);
  git(['commit', '-qm', 'Fixture']);
  const sourceSha = git(['rev-parse', 'HEAD']);
  f.identity.source_sha = sourceSha;
  f.authority.source_sha = sourceSha;
  f.buildManifest.source_sha = sourceSha;
  f.snapshot.values.CI_RELEASE_SKILLS_CONFIG_PATH = configPath;
  f.snapshot.digest = sha256(Buffer.from(canonicalJson({ sources: f.snapshot.sources, values: f.snapshot.values })));
  f.authority.config_snapshot_digest = f.snapshot.digest;
  f.put('snapshot.json', f.snapshot);
  f.put('authority.json', f.authority);
  f.put('build/release-build-linux/asset-manifest.json', f.buildManifest);
  f.options.skillsSourceRoot = f.root;
  f.put('skills/example-tool/tmp/untracked.py', 'untracked residual');
  return f;
};

export const selectedReleaseSkillsFixture = (t) => releaseSkillsFixture(t, (config, root) => {
  config.skills = [
    { path: '.', name: 'root-tool' },
    { path: '.agents/skills/sdd', name: 'sdd' },
    { path: 'packages/[public]/日本語 tools', name: 'nested-tool' },
    { path: 'packages/[public]/日本語 tools/child', name: 'child-tool' },
  ].map(({ path: directory, name }) => {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
    fs.writeFileSync(path.join(root, directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Selected public skill.\n---\n`);
    return { path: directory, include: ['SKILL.md'], requiredFiles: ['SKILL.md'] };
  });
}, () => {}, '.ci/selected-skills.json');

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

// Converts a fixture into an asset release: authority and snapshot record no platform, and no build input is passed.
export const toAssetRelease = (f) => {
  f.snapshot.values.CI_RELEASE_IMPLEMENTATION = 'asset-release';
  f.snapshot.values.CI_PLATFORM_MANIFEST = '__unset__';
  f.snapshot.digest = sha256(Buffer.from(canonicalJson({ sources: f.snapshot.sources, values: f.snapshot.values })));
  Object.assign(f.authority, { language_profile: null, toolchain_version: null, platform_manifest: null, platform_manifest_sha256: null, config_snapshot_digest: f.snapshot.digest });
  f.put('snapshot.json', f.snapshot);
  f.put('authority.json', f.authority);
  delete f.options.platformManifestPath;
  delete f.options.platformMatrix;
  delete f.options.buildRoot;
  return f;
};

// Selects one owner-adapter supplemental asset with complete opaque evidence.
export const putSupplementalAsset = (f, ownerContract = 'project.asset-evidence') => {
  f.snapshot.values.CI_SUPPLEMENTAL_RELEASE_ASSET_ENABLED = 'true';
  f.snapshot.values.CI_SUPPLEMENTAL_RELEASE_ASSET_OWNER_CONTRACT = ownerContract;
  f.snapshot.digest = sha256(Buffer.from(canonicalJson({ sources: f.snapshot.sources, values: f.snapshot.values })));
  f.authority.config_snapshot_digest = f.snapshot.digest;
  f.put('snapshot.json', f.snapshot);
  f.put('authority.json', f.authority);
  const asset = { path: 'instructions.zip', sha256: sha256(Buffer.from('instructions')), checksum_path: 'instructions.zip.sha256', owner_evidence_path: 'owner.json', owner_evidence_sha256: sha256(Buffer.from('opaque owner record')), provenance_path: 'provenance.json', verification_path: 'verification.json' };
  f.put('supplemental/instructions.zip', 'instructions');
  f.put('supplemental/instructions.zip.sha256', `${asset.sha256}  instructions.zip\n`);
  f.put('supplemental/owner.json', 'opaque owner record');
  f.put('supplemental/provenance.json', 'opaque provenance');
  f.put('supplemental/verification.json', { status: 'success', owner_contract: ownerContract, source_sha: f.identity.source_sha, asset_sha256: asset.sha256, owner_evidence_sha256: asset.owner_evidence_sha256, provenance_sha256: sha256(Buffer.from('opaque provenance')) });
  f.put('supplemental/supplemental-manifest.json', { schema_version: '1', kind: 'ci-github-supplemental-handoff', owner_contract: ownerContract, source_sha: f.identity.source_sha, version: f.identity.version, assets: [asset] });
  f.options.supplementalRoot = path.join(f.root, 'supplemental');
  return f;
};
