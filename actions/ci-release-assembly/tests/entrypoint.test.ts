import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { describe, test, expect, type TestContext } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fixture, releaseSkillsFixture, selectedReleaseSkillsFixture, toAssetRelease, putSupplementalAsset } from '../../../runtime/release-publication/tests/fixtures.mjs';
import { loadAssembly } from '../../../runtime/release-publication/observation.js';

import { actionEntrypointArguments } from '../../../tests/support/action-entrypoint';

describe.each(['source', 'dist'] as const)('%s entrypoint', (surface) => {
  const entrypointArgs = actionEntrypointArguments(path.resolve(__dirname, '..'), surface);
const bundle = entrypointArgs;
const environment = (options: Record<string, string>, output: string, inherited = process.env): NodeJS.ProcessEnv => ({
  ...inherited, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output,
  INPUT_REPOSITORY: options.repository, 'INPUT_AUTHORITY-PATH': options.authorityPath,
  'INPUT_SNAPSHOT-PATH': options.snapshotPath, 'INPUT_PLATFORM-MANIFEST-PATH': options.platformManifestPath ?? '',
  'INPUT_PLATFORM-MATRIX': options.platformMatrix ?? '', 'INPUT_BUILD-ROOT': options.buildRoot ?? '',
  'INPUT_SUPPLEMENTAL-ROOT': options.supplementalRoot ?? '',
  'INPUT_OUTPUT-DIRECTORY': options.outputRoot,
  'INPUT_SKILLS-SOURCE-ROOT': options.skillsSourceRoot ?? '',
});

const missingBuildInventory = (t: TestContext) => {
  const f = fixture(t);
  const output = f.put('github-output', '');
  fs.renameSync(path.join(f.options.buildRoot, 'release-build-linux'), path.join(f.root, 'saved-build'));
  const result = spawnSync(process.execPath, [...bundle], { env: environment(f.options, output), encoding: 'utf8', cwd: f.root });
  const line = result.stderr.split('\n').find((value) => value.startsWith('ci-failure-diagnostic:'));
  const evidence = JSON.parse(line?.slice('ci-failure-diagnostic:'.length) ?? '{}');
  return { f, output, result, evidence };
};

// contract_id: contract.ci-release-assembly.outputs
// flow_id: release-assembly-detailed-failure
test('missing build inventory rejects assembly before outputs', (t) => {
  const { f, output, result, evidence } = missingBuildInventory(t);
  expect(result.status).toBe(1);
  expect(evidence.classification.stage).toBe('build-inventory');
  expect(fs.readFileSync(output, 'utf8')).toBe('');
  expect(fs.existsSync(f.options.outputRoot)).toBe(false);
});

// contract_id: contract.ci-failure-diagnostics.actionable
// flow_id: release-assembly-failure-diagnostics
test('missing build inventory records actionable failure details', (t) => {
  const { result, evidence } = missingBuildInventory(t);
  expect(result.status).toBe(1);
  expect(evidence.classification).toMatchObject({ subject: 'ci-release-assembly', stage: 'build-inventory', reason: 'asset-set-mismatch' });
  expect(evidence.comparison).toMatchObject({ field: 'build-directories', missing: ['release-build-linux'], extra: [] });
  expect(evidence['execution-state']).toMatchObject({ outcome: 'failure', write: 'not-started' });
});

// Verifies a sidecar as a standard sha256 checksum file does: each line is `<lowercase sha256><two spaces><asset name>` and matches the actual bytes of that asset.
const sidecarVerifiesAsset = (assetsDirectory: string, sidecar: string): boolean => {
  const text = fs.readFileSync(path.join(assetsDirectory, sidecar), 'utf8');
  if (!text.endsWith('\n')) return false;
  return text.slice(0, -1).split('\n').every((line) => {
    const match = /^([0-9a-f]{64}) {2}([^\s/]+)$/.exec(line);
    return match !== null && fs.existsSync(path.join(assetsDirectory, match[2]!))
      && crypto.createHash('sha256').update(fs.readFileSync(path.join(assetsDirectory, match[2]!))).digest('hex') === match[1];
  });
};

// contract_id: contract.ci-release-assembly.outputs
// flow_id: release-assembly-entrypoint
test('assembly bundle packages selected release skills', (t) => {
  // Arrange
  const f = selectedReleaseSkillsFixture(t);
  const output = f.put('github-output', '');
  // Act
  const result = spawnSync(process.execPath, [...bundle], { env: environment(f.options, output), encoding: 'utf8', cwd: f.root });
  // Assert
  expect(result.status, result.stderr).toBe(0);
  expect(fs.readFileSync(output, 'utf8')).toContain('status=success\n');
  expect(fs.readFileSync(output, 'utf8')).toContain(`release-handoff=${f.options.outputRoot}\n`);
  const assembly = JSON.parse(fs.readFileSync(path.join(f.options.outputRoot, 'assembly.json'), 'utf8'));
  expect(assembly.assets.map((asset: { name: string }) => asset.name)).toContain('project-skills.zip');
  expect(fs.readdirSync(path.join(f.options.outputRoot, 'evidence'))).toHaveLength(3);
  const owner = JSON.parse(fs.readFileSync(path.join(f.options.outputRoot, 'evidence/evidence-4-project-skills.zip.owner.json'), 'utf8'));
  expect(owner.files.map((entry: { path: string }) => entry.path)).toEqual(['child-tool/SKILL.md', 'nested-tool/SKILL.md', 'root-tool/SKILL.md', 'sdd/SKILL.md']);
  f.options.outputRoot = path.join(f.root, 'invalid-skills');
  fs.writeFileSync(output, '');
  const rejected = spawnSync(process.execPath, [...bundle], { env: { ...environment(f.options, output), 'INPUT_SKILLS-SOURCE-ROOT': '' }, encoding: 'utf8', cwd: f.root });
  expect(rejected.status).toBe(1);
  expect(rejected.stderr).toContain('skills-source-selection-mismatch');
  expect(fs.readFileSync(output, 'utf8')).toBe('');
  expect(fs.existsSync(f.options.outputRoot)).toBe(false);
});

// contract_id: contract.ci-release-assembly.outputs
// flow_id: release-assembly-entrypoint
test('assembly bundle emits bound outputs only on complete success', (t) => {
  const f = fixture(t, { id: 'linux', runner: 'ubuntu-22.04', target: 'x86_64-unknown-linux-gnu' });
  const output = f.put('github-output', '');
  const payload = Buffer.from('verified archive bytes');
  const payloadDigest = crypto.createHash('sha256').update(payload).digest('hex');
  const checksum = Buffer.from(`${payloadDigest}  project-1.0.0-linux.tar.gz\n`);
  const assets = [
    { name: 'project-1.0.0-linux.tar.gz', sha256: payloadDigest, size: payload.length },
    { name: 'project-1.0.0-linux.tar.gz.sha256', sha256: crypto.createHash('sha256').update(checksum).digest('hex'), size: checksum.length },
  ];
  const digest = crypto.createHash('sha256').update(JSON.stringify(assets)).digest('hex');
  const { SystemRoot, TEMP, TMP, TMPDIR } = process.env;
  const env = environment(f.options, output, { SystemRoot, TEMP, TMP, TMPDIR, PATH: path.join(f.root, 'no-cli') });
  const result = spawnSync(process.execPath, [...bundle], { env, encoding: 'utf8', cwd: f.root });
  expect(result.status, result.stderr).toBe(0);
  expect(fs.readFileSync(output, 'utf8')).toBe(`status=success\nrelease-handoff=${f.options.outputRoot}\nasset-digest=${digest}\n`);
  const assembly = JSON.parse(fs.readFileSync(path.join(f.options.outputRoot, 'assembly.json'), 'utf8'));
  expect(assembly.assets).toStrictEqual(assets);
  expect(assembly.asset_digest).toBe(digest);
  expect(loadAssembly({ ...f.options, handoffRoot: f.options.outputRoot }).assembly.asset_digest).toBe(digest);
  expect(assembly.identity.source_sha).toBe(f.identity.source_sha);
  const assetsDirectory = path.join(f.options.outputRoot, 'assets');
  expect(fs.readdirSync(assetsDirectory).filter((name) => name.endsWith('.sha256'))).toStrictEqual(['project-1.0.0-linux.tar.gz.sha256']);
  expect(sidecarVerifiesAsset(assetsDirectory, 'project-1.0.0-linux.tar.gz.sha256')).toBe(true);
  expect(JSON.parse(fs.readFileSync(path.join(f.options.outputRoot, 'handoff.json'), 'utf8')).source_sha).toBe(f.identity.source_sha);
});

// contract_id: contract.ci-release-assembly.outputs
// flow_id: release-assembly-output-injection-rejection
test('assembly bundle rejects output path line injection before assembly', (t) => {
  const f = fixture(t);
  const output = f.put('github-output', '');
  const injected = `${f.options.outputRoot}\nstatus=success`;
  const result = spawnSync(process.execPath, [...bundle], {
    env: { ...environment(f.options, output), 'INPUT_OUTPUT-DIRECTORY': injected },
    encoding: 'utf8', cwd: f.root,
  });
  expect(result.status).toBe(1);
  expect(fs.readFileSync(output, 'utf8')).toBe('');
  expect(fs.existsSync(f.options.outputRoot)).toBe(false);
  expect(fs.existsSync(injected)).toBe(false);
  expect(result.stderr).toMatch(/input-invalid:output-directory/);
});

// contract_id: contract.ci-release-assembly.outputs
// flow_id: release-assembly-entrypoint-rejection
test('assembly bundle rejects invalid input without successful outputs', (t) => {
  const f = fixture(t);
  const output = f.put('github-output', '');
  const result = spawnSync(process.execPath, [...bundle], { env: { ...environment(f.options, output), PATH: path.join(f.root, 'no-cli'), INPUT_REPOSITORY: 'other/repository' }, encoding: 'utf8', cwd: f.root });
  expect(result.status).toBe(1);
  expect(fs.readFileSync(output, 'utf8')).toBe('');
  expect(result.stderr).toMatch(/authority-handoff-binding-mismatch/);
});

// contract_id: contract.ci-release-assembly.outputs
// flow_id: release-assembly-entrypoint
test('assembly bundle assembles an asset release without build inputs and fails an empty selection', (t) => {
  // Arrange
  const f = putSupplementalAsset(toAssetRelease(selectedReleaseSkillsFixture(t)));
  const output = f.put('github-output', '');
  const empty = toAssetRelease(fixture(t));
  const emptyOutput = empty.put('github-output', '');
  // Act
  const result = spawnSync(process.execPath, [...bundle], { env: environment(f.options, output), encoding: 'utf8', cwd: f.root });
  const rejected = spawnSync(process.execPath, [...bundle], { env: environment(empty.options, emptyOutput), encoding: 'utf8', cwd: empty.root });
  // Assert
  expect(result.status, result.stderr).toBe(0);
  const outputs = fs.readFileSync(output, 'utf8');
  expect(outputs).toContain('status=success\n');
  expect(outputs).toContain(`release-handoff=${f.options.outputRoot}\n`);
  expect(outputs).toMatch(/^asset-digest=[0-9a-f]{64}$/m);
  const assembly = JSON.parse(fs.readFileSync(path.join(f.options.outputRoot, 'assembly.json'), 'utf8'));
  expect(assembly.assets.map((asset: { name: string }) => asset.name)).toEqual(expect.arrayContaining(['project-skills.zip', 'instructions.zip']));
  const expectedDigest = crypto.createHash('sha256').update(JSON.stringify(assembly.assets)).digest('hex');
  expect(outputs).toContain(`asset-digest=${expectedDigest}\n`);
  const reloaded = loadAssembly({ ...f.options, handoffRoot: f.options.outputRoot }).assembly;
  expect(reloaded.asset_digest).toBe(expectedDigest);
  expect(reloaded.identity.source_sha).toBe(f.identity.source_sha);
  expect(rejected.status).toBe(1);
  expect(rejected.stderr).toContain('asset-set-empty');
  expect(rejected.stderr).toMatch(/^ci-failure-diagnostic:.*"stage":"[^"]+"/m);
  expect(fs.readFileSync(emptyOutput, 'utf8')).toBe('');
  expect(fs.existsSync(empty.options.outputRoot)).toBe(false);
});

const runAssembly = (f: ReturnType<typeof fixture>) => {
  const output = f.put('github-output', '');
  const result = spawnSync(process.execPath, [...bundle], { env: environment(f.options, output), encoding: 'utf8', cwd: f.root });
  return { result, outputs: fs.readFileSync(output, 'utf8') };
};
const expectAssemblyRejected = (f: ReturnType<typeof fixture>, run: ReturnType<typeof runAssembly>, reason: RegExp) => {
  expect(run.result.status).toBe(1);
  expect(run.outputs).toBe('');
  expect(run.result.stderr).toMatch(reason);
  expect(fs.existsSync(f.options.outputRoot)).toBe(false);
};

// contract_id: contract.ci-release-assembly.outputs
// flow_id: release-assembly-entrypoint
test('assembly bundle binds supplemental owner evidence into the handoff', (t) => {
  // Arrange
  const f = putSupplementalAsset(fixture(t));
  // Act
  const run = runAssembly(f);
  // Assert
  expect(run.result.status, run.result.stderr).toBe(0);
  expect(run.outputs).toContain('status=success\n');
  expect(run.outputs).toContain(`release-handoff=${f.options.outputRoot}\n`);
  const assembly = JSON.parse(fs.readFileSync(path.join(f.options.outputRoot, 'assembly.json'), 'utf8'));
  expect(assembly.assets.map((asset: { name: string }) => asset.name)).toEqual(expect.arrayContaining([f.name, 'instructions.zip']));
  const evidenceDirectory = path.join(f.options.outputRoot, 'evidence');
  const evidence = fs.readdirSync(evidenceDirectory);
  const supplied = ['owner.json', 'provenance.json', 'verification.json'];
  expect(evidence).toHaveLength(supplied.length);
  for (const file of supplied) {
    const retained = evidence.filter(name => name.endsWith(`-${file}`));
    expect(retained, file).toHaveLength(1);
    expect(fs.readFileSync(path.join(evidenceDirectory, retained[0]))).toEqual(
      fs.readFileSync(path.join(f.options.supplementalRoot, file)),
    );
  }
});

// contract_id: contract.ci-release-assembly.outputs
// flow_id: release-assembly-entrypoint-rejection
test('assembly bundle rejects a build manifest that names another source', (t) => {
  // Arrange
  const f = fixture(t);
  f.put('build/release-build-linux/asset-manifest.json', { ...f.buildManifest, source_sha: 'c'.repeat(40) });
  // Act
  const run = runAssembly(f);
  // Assert
  expectAssemblyRejected(f, run, /source-identity-mismatch/);
});

// contract_id: contract.ci-release-assembly.outputs
// flow_id: release-assembly-entrypoint-rejection
test('assembly bundle rejects a checksum sidecar with a single-space separator', (t) => {
  // Arrange
  const f = fixture(t);
  f.put(`build/release-build-linux/${f.name}.sha256`, `${crypto.createHash('sha256').update(f.payload).digest('hex')} ${f.name}\n`);
  // Act
  const run = runAssembly(f);
  // Assert
  expectAssemblyRejected(f, run, /checksum-mismatch/);
});

// contract_id: contract.ci-release-assembly.outputs
// flow_id: release-assembly-entrypoint
test('assembly bundle preserves manifest identity across CRLF and mixed checkouts', (t) => {
  for (const lineEndings of ['CRLF', 'mixed']) {
    const f = fixture(t);
    const lf = fs.readFileSync(f.options.platformManifestPath, 'utf8');
    const manifest = lineEndings === 'CRLF' ? lf.replaceAll('\n', '\r\n') : lf.replace('\n', '\r\n');
    fs.writeFileSync(f.options.platformManifestPath, manifest);
    const run = runAssembly(f);
    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.outputs).toMatch(/^asset-digest=[0-9a-f]{64}$/m);
    expect(run.outputs).toContain(`release-handoff=${f.options.outputRoot}\n`);
    const assembly = JSON.parse(fs.readFileSync(path.join(f.options.outputRoot, 'assembly.json'), 'utf8'));
    expect(assembly.identity).toStrictEqual(f.identity);
    expect(fs.existsSync(path.join(f.options.outputRoot, 'handoff.json'))).toBe(true);
  }
});

// contract_id: contract.ci-release-assembly.outputs
// flow_id: release-assembly-entrypoint-rejection
test('assembly bundle rejects platform manifest edits beyond line endings', (t) => {
  const f = fixture(t);
  const lf = fs.readFileSync(f.options.platformManifestPath, 'utf8');
  fs.writeFileSync(f.options.platformManifestPath, `${lf}\n# content changed\n`.replaceAll('\n', '\r\n'));
  expectAssemblyRejected(f, runAssembly(f), /platform-mismatch/);
});

// contract_id: contract.ci-release-assembly.outputs
// flow_id: release-assembly-entrypoint-rejection
test('assembly bundle rejects a selected skill without its required SKILL.md', (t) => {
  // Arrange
  const f = releaseSkillsFixture(t, (_configuration: unknown, root: string) => { fs.unlinkSync(path.join(root, 'skills/example-tool/SKILL.md')); });
  // Act
  const run = runAssembly(f);
  // Assert
  expectAssemblyRejected(f, run, /skills-required-file-missing/);
});

// contract_id: contract.ci-release-assembly.outputs
// flow_id: release-assembly-entrypoint-rejection
test('assembly retains the verified handoff when the Action output write fails', (t) => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [...bundle], {
    env: environment(f.options, f.root), encoding: 'utf8', cwd: f.root,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('"stage":"output-write"');
  expect(loadAssembly({ ...f.options, handoffRoot: f.options.outputRoot }).assembly.identity).toStrictEqual(f.identity);
});

});
