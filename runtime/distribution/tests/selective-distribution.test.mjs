import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, test } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  applyDistributionPlan,
  fetchDistribution,
  loadDistributionManifest,
  planDistributionApplication,
  resolveDistributionSelection,
  rollbackDistributionTransaction,
  validateDistributionManifest,
  verifyFetchedDistribution,
} from '../fetch-a3-ci-github.mjs';
import { loadReleaseRequestFixtureModel, snapshotTree, writeReleaseRequestFixture } from '../../preset/tests/support/release-request-fixture.mjs';

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testRoot, '../../..');
const tsx = path.join(repositoryRoot, 'runtime/preset/node_modules/.bin/tsx');
const releaseTag = `v${fs.readFileSync(path.join(repositoryRoot, 'VERSION'), 'utf8').trim()}`;
const temporaryRoot = path.join(repositoryRoot, 'tmp');
fs.mkdirSync(temporaryRoot, { recursive: true });
const committedSourceRoot = fs.mkdtempSync(path.join(temporaryRoot, 'distribution-source-'));
for (const relative of [
  'VERSION',
  '.github/workflows/ci-quality.yml',
  '.github/workflows/ci-quality-platforms.yml',
  '.github/workflows/ci-package-preparation.yml',
  '.github/workflows/ci-release-publication.yml',
  '.github/workflows/ci-package-publication.yml',
  'skills/ci-github',
  'workflows',
  'runtime/preset',
  'runtime/platform',
  'runtime/release-publication/evidence.schema.json',
  'runtime/adapter',
  'runtime/path',
  'runtime/vitest',
  'runtime/distribution',
  'lint-rules/a3-lint',
]) {
  const source = path.join(repositoryRoot, relative);
  const destination = path.join(committedSourceRoot, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, {
    recursive: true,
    filter: (candidate) => !candidate.split(path.sep).includes('node_modules'),
  });
}
const runFixtureGit = (args) => {
  const result = spawnSync('git', args, { cwd: committedSourceRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
runFixtureGit(['init', '-q']);
runFixtureGit(['config', 'user.name', 'Distribution Test']);
runFixtureGit(['config', 'user.email', 'distribution-test@example.invalid']);
runFixtureGit(['add', '--all']);
runFixtureGit(['commit', '-qm', 'fixture']);
const sourceRevision = runFixtureGit(['rev-parse', 'HEAD']);
afterAll(() => fs.rmSync(committedSourceRoot, { recursive: true, force: true }));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const withFixture = async (name, callback) => {
  const root = fs.mkdtempSync(path.join(temporaryRoot, name));
  try {
    return await callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const prepareRelease = (root) => {
  const output = path.join(root, 'release');
  const result = spawnSync(tsx, [
    path.join(repositoryRoot, 'runtime/distribution/generate-distribution-release.ts'),
    '--repository-root', committedSourceRoot,
    '--output-directory', output,
    '--source-revision', sourceRevision,
    '--release-tag', releaseTag,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return {
    output,
    manifestPath: path.join(output, 'a3-ci-github-distribution-manifest.json'),
    manifestBytes: fs.readFileSync(path.join(output, 'a3-ci-github-distribution-manifest.json')),
    manifest: JSON.parse(fs.readFileSync(path.join(output, 'a3-ci-github-distribution-manifest.json'), 'utf8')),
  };
};

// contract_id: contract.ci-selective-distribution.delivery
test('release generator derives deterministic selective assets and checksums from registries', async () => {
  await withFixture('a3-ci-github-distribution-release-', (root) => {
    const first = prepareRelease(root);
    const manifest = validateDistributionManifest(first.manifest);
    assert.equal(manifest.sourceRevision, sourceRevision);
    assert.ok(manifest.assets.some((asset) => asset.id === 'runtime.preset'));
    assert.ok(manifest.assets.some((asset) => asset.id === 'workflow.quality-gate'));
    assert.ok(manifest.files['skills/ci-github/references/ci-script-contracts.reference.yml']);
    for (const relative of [
      'skills/ci-github/references/release-publication-evidence.reference.yml',
      'runtime/release-publication/evidence.schema.json',
      'runtime/preset/action-availability.ts',
      '.github/workflows/ci-quality-platforms.yml',
      '.github/workflows/ci-package-preparation.yml',
      '.github/workflows/ci-release-publication.yml',
      '.github/workflows/ci-package-publication.yml',
    ]) {
      const bytes = fs.readFileSync(path.join(committedSourceRoot, relative));
      assert.equal(manifest.files[relative].sha256, sha256(bytes));
      assert.equal(manifest.files[relative].size, bytes.length);
    }
    const publication = resolveDistributionSelection(manifest, ['release-publication'], []);
    const publicationFiles = publication.flatMap((asset) => asset.files.map((file) => file.sourcePath));
    const releaseEvidenceFiles = [
      'skills/ci-github/references/release-publication-evidence.reference.yml',
      'runtime/release-publication/evidence.schema.json',
    ];
    for (const relative of releaseEvidenceFiles) assert.ok(publicationFiles.includes(relative));
    for (const preset of ['quality-gate', 'release-request', 'package-publication']) {
      const files = resolveDistributionSelection(manifest, [preset], [])
        .flatMap((asset) => asset.files.map((file) => file.sourcePath));
      for (const relative of releaseEvidenceFiles) assert.equal(files.includes(relative), false, `${preset}: ${relative}`);
    }
    assert.ok(publicationFiles.includes('runtime/preset/action-availability.ts'));
    assert.equal(publicationFiles.some((relative) => relative.startsWith('actions/')), false);
    const packagePreset = manifest.presets.find((preset) => preset.id === 'package-publication');
    assert.deepEqual(packagePreset.requiredAssets.filter((id) => id.startsWith('workflow.')).sort(), ['workflow.package-publication-caller', 'workflow.package-publication-request']);
    assert.equal(manifest.assets.some((asset) => asset.id === 'workflow.package-preparation'), false);
    const quality = manifest.presets.find((preset) => preset.id === 'quality-gate');
    assert.ok(quality.requiredAssets.includes('workflow.quality-gate'));
    assert.ok(quality.requiredAssets.includes('runtime.preset'));
    assert.ok(quality.optionalAssets.includes('workflow.quality-gate-platforms'));
    const checksums = fs.readFileSync(path.join(first.output, 'SHA256SUMS'), 'utf8');
    assert.match(checksums, new RegExp(sha256(first.manifestBytes)));
    assert.match(checksums, /fetch-a3-ci-github\.mjs/);
  });
});

// contract_id: contract.ci-selective-distribution.selection
test('preset closure includes only its reusable workflow sources and excludes optional materializer', async () => {
  await withFixture('a3-ci-github-distribution-source-selection-', (root) => {
    const { manifest } = prepareRelease(root);
    const expected = {
      'quality-gate': ['ci-quality.yml'],
      'release-request': [],
      'release-publication': ['ci-release-publication.yml'],
      'package-publication': ['ci-package-preparation.yml', 'ci-package-publication.yml'],
    };
    for (const [preset, workflows] of Object.entries(expected)) {
      const selected = resolveDistributionSelection(manifest, [preset], []);
      assert.equal(selected.some((asset) => asset.id === 'runtime.adapter-materializer'), false);
      assert.deepEqual(selected.flatMap((asset) => asset.files.map((file) => file.sourcePath))
        .filter((source) => source.startsWith('.github/workflows/')).sort(),
      workflows.map((file) => `.github/workflows/${file}`).sort());
    }
    assert.throws(() => resolveDistributionSelection(manifest, ['quality-gate'], ['workflow.quality-gate-platforms']),
      /distribution-dependency-missing:workflow.quality-gate-platforms:runtime.quality-platforms-workflow/);
    const platforms = resolveDistributionSelection(manifest, ['quality-gate'],
      ['workflow.quality-gate-platforms', 'runtime.quality-platforms-workflow']);
    assert.deepEqual(platforms.flatMap((asset) => asset.files.map((file) => file.sourcePath))
      .filter((source) => source.startsWith('.github/workflows/')).sort(),
    ['.github/workflows/ci-quality-platforms.yml', '.github/workflows/ci-quality.yml']);
    assert.throws(() => resolveDistributionSelection(manifest, [], ['runtime.adapter-materializer']),
      /distribution-dependency-missing:runtime.adapter-materializer:runtime.preset/);
  });
});

// contract_id: contract.ci-selective-distribution.delivery
test('each selected callee resolves from fetched sources and missing sources remain rejected', async () => {
  await withFixture('a3-ci-github-distribution-callee-preflight-', async (root) => {
    const release = prepareRelease(root);
    for (const [preset, asset, binding, job, resolver, extras] of [
      ['quality-gate', 'quality-gate', 'qualityReusableWorkflow', 'quality', 'resolveQualityWorkflow', []],
      ['quality-gate', 'quality-gate-platforms', 'qualityPlatformsReusableWorkflow', 'platforms', 'resolveQualityWorkflow', ['workflow.quality-gate-platforms', 'runtime.quality-platforms-workflow']],
      ['release-publication', 'release-publication-caller', 'releasePublicationReusableWorkflow', 'publish', 'resolvePublicationWorkflow', []],
      ['package-publication', 'package-publication-caller', 'packagePublicationReusableWorkflow', 'publish', 'resolvePublicationWorkflow', []],
    ]) {
      const projectRoot = path.join(root, asset);
      fs.mkdirSync(projectRoot);
      const fetched = await fetchDistribution({ projectRoot, manifest: release.manifest, manifestBytes: release.manifestBytes,
        requestedPresets: [preset], requestedAssets: extras, sourceRoot: repositoryRoot });
      const scriptPath = path.join(root, `${asset}.mts`);
      fs.writeFileSync(scriptPath, `import assert from 'node:assert/strict';
        import fs from 'node:fs';
        import { ${resolver} } from ${JSON.stringify(pathToFileURL(path.join(fetched.distributionRoot, 'runtime/preset/ci-preset-assets.ts')).href)};
        import { loadRegistry } from ${JSON.stringify(pathToFileURL(path.join(fetched.distributionRoot, 'runtime/preset/preset-registry.ts')).href)};
        const report = { missingSettings: [], mismatches: [] };
        const registry = loadRegistry(report);
        assert.deepEqual(report.mismatches, []);
        const source = registry[${JSON.stringify(binding)}].source;
        const workflow = { jobs: { ${job}: { uses: registry.actionRepository + '/' + source + '@' + 'a'.repeat(40), with: {} } } };
        assert.ok(${resolver}(workflow, registry, report).env);
        assert.deepEqual(report.mismatches, []);
        fs.unlinkSync(${JSON.stringify(fetched.distributionRoot)} + '/' + source);
        ${resolver}(workflow, registry, report);
        assert.ok(report.mismatches.some(item => item.path === source && item.message.includes('missing')));`);
      const result = spawnSync(tsx, [scriptPath], { encoding: 'utf8', env: {
        ...process.env, CI_GITHUB_PREFLIGHT_RUNTIME_ROOT: path.join(repositoryRoot, 'runtime/preset'),
      } });
      assert.equal(result.status, 0, result.stderr);
    }
  });
});

// contract_id: contract.ci-selective-distribution.delivery
test('release generator binds every published byte to the exact source commit', async () => {
  await withFixture('a3-ci-github-distribution-release-binding-', (root) => {
    const sourcePath = 'workflows/quality/quality-gate.yml';
    const workingPath = path.join(committedSourceRoot, sourcePath);
    const committedBytes = fs.readFileSync(workingPath);
    try {
      fs.writeFileSync(workingPath, 'working-tree-only-change\n');
      const release = prepareRelease(root);
      assert.equal(release.manifest.files[sourcePath].sha256, sha256(committedBytes));
      assert.notEqual(release.manifest.files[sourcePath].sha256, sha256(Buffer.from('working-tree-only-change\n')));
    } finally {
      fs.writeFileSync(workingPath, committedBytes);
    }
  });
});

// contract_id: contract.ci-selective-distribution.delivery
test('release generator rejects invalid version source and output boundaries', async () => {
  await withFixture('a3-ci-github-distribution-release-guards-', (root) => {
    const generator = path.join(repositoryRoot, 'runtime/distribution/generate-distribution-release.ts');
    const execute = (args) => spawnSync(tsx, [generator, '--repository-root', committedSourceRoot, ...args], { encoding: 'utf8' });
    const invalidSha = execute([
      '--output-directory', path.join(root, 'invalid-sha'),
      '--source-revision', 'main',
      '--release-tag', releaseTag,
    ]);
    assert.equal(invalidSha.status, 2);
    assert.match(invalidSha.stderr, /distribution-release-source-revision-invalid/);
    const invalidTag = execute([
      '--output-directory', path.join(root, 'invalid-tag'),
      '--source-revision', sourceRevision,
      '--release-tag', 'latest',
    ]);
    assert.equal(invalidTag.status, 2);
    assert.match(invalidTag.stderr, /distribution-release-tag-invalid/);
    const versionMismatch = execute([
      '--output-directory', path.join(root, 'version-mismatch'),
      '--source-revision', sourceRevision,
      '--release-tag', 'v9.9.9',
    ]);
    assert.equal(versionMismatch.status, 2);
    assert.match(versionMismatch.stderr, /distribution-release-version-mismatch/);
    const headMismatch = execute([
      '--output-directory', path.join(root, 'head-mismatch'),
      '--source-revision', 'e'.repeat(40),
      '--release-tag', releaseTag,
    ]);
    assert.equal(headMismatch.status, 2);
    assert.match(headMismatch.stderr, /distribution-release-source-head-mismatch/);
    const existingOutput = path.join(root, 'existing');
    fs.mkdirSync(existingOutput);
    const outputConflict = execute([
      '--output-directory', existingOutput,
      '--source-revision', sourceRevision,
      '--release-tag', releaseTag,
    ]);
    assert.equal(outputConflict.status, 2);
    assert.match(outputConflict.stderr, /distribution-release-output-exists/);
  });
});

// contract_id: contract.ci-selective-distribution.delivery
test('manifest validation rejects malformed authority identity files and dependency references', async () => {
  await withFixture('a3-ci-github-distribution-manifest-validation-', (root) => {
    const { manifest } = prepareRelease(root);
    const cases = [
      [null, /distribution-manifest-invalid/],
      [{ ...manifest, schemaVersion: '2' }, /distribution-manifest-contract-unsupported/],
      [{ ...manifest, repository: 'other/repository' }, /distribution-manifest-source-untrusted/],
      [{ ...manifest, sourceRevision: 'main' }, /distribution-manifest-source-revision-invalid/],
      [{ ...manifest, releaseTag: 'latest' }, /distribution-manifest-release-tag-invalid/],
      [{ ...manifest, assets: null }, /distribution-manifest-shape-invalid/],
    ];
    for (const [candidate, diagnostic] of cases) {
      assert.throws(() => validateDistributionManifest(candidate), diagnostic);
    }
    const duplicate = structuredClone(manifest);
    duplicate.assets.push(structuredClone(duplicate.assets[0]));
    assert.throws(() => validateDistributionManifest(duplicate), /distribution-manifest-asset-invalid/);
    const invalidFile = structuredClone(manifest);
    const sourcePath = invalidFile.assets[0].files[0].sourcePath;
    invalidFile.files[sourcePath].sha256 = 'invalid';
    assert.throws(() => validateDistributionManifest(invalidFile), /distribution-manifest-file-invalid/);
    const unknownDependency = structuredClone(manifest);
    unknownDependency.assets[0].dependencies.push('unknown');
    assert.throws(() => validateDistributionManifest(unknownDependency), /distribution-dependency-unknown/);
    const unknownPresetAsset = structuredClone(manifest);
    unknownPresetAsset.presets[0].requiredAssets.push('unknown');
    assert.throws(() => validateDistributionManifest(unknownPresetAsset), /distribution-preset-asset-unknown/);
  });
});

// contract_id: contract.ci-selective-distribution.delivery
test('remote manifest loading confines the Release URL and release tag mapping', async () => {
  await withFixture('a3-ci-github-distribution-remote-manifest-', async (root) => {
    const release = prepareRelease(root);
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (url) => {
        const parsed = new URL(String(url));
        if (parsed.hostname === 'github.com') {
          return {
            ok: false,
            status: 302,
            headers: { get: () => 'https://release-assets.githubusercontent.com/signed-manifest' },
          };
        }
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          arrayBuffer: async () => release.manifestBytes,
        };
      };
      const validUrl = `https://github.com/a3-suite/a3-ci-github/releases/download/${releaseTag}/a3-ci-github-distribution-manifest.json`;
      const loaded = await loadDistributionManifest({ manifestUrl: validUrl });
      assert.equal(loaded.manifest.sourceRevision, sourceRevision);
      await assert.rejects(
        loadDistributionManifest({
          manifestUrl: 'https://github.com/a3-suite/a3-ci-github/releases/download/v9.9.9/a3-ci-github-distribution-manifest.json',
        }),
        /distribution-manifest-release-url-mismatch/,
      );
      await assert.rejects(
        loadDistributionManifest({ manifestUrl: 'https://example.invalid/manifest.json' }),
        /distribution-manifest-url-untrusted/,
      );
      await assert.rejects(
        loadDistributionManifest({ manifestPath: release.manifestPath, manifestUrl: validUrl }),
        /distribution-manifest-source-exclusive/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// contract_id: contract.ci-selective-distribution.selection
test('preset selection closes dependencies while direct asset selection reports missing dependencies', async () => {
  await withFixture('a3-ci-github-distribution-selection-', (root) => {
    const { manifest } = prepareRelease(root);
    const presetAssets = resolveDistributionSelection(manifest, ['quality-gate'], []);
    assert.ok(presetAssets.some((asset) => asset.id === 'registry.ci-github'));
    assert.ok(presetAssets.some((asset) => asset.id === 'workflow.quality-gate'));
    assert.throws(() => resolveDistributionSelection(manifest, [], []), /distribution-selection-required/);
    assert.throws(() => resolveDistributionSelection(manifest, ['unknown'], []), /distribution-preset-unknown/);
    assert.throws(() => resolveDistributionSelection(manifest, [], ['unknown']), /distribution-asset-unknown/);
    assert.throws(
      () => resolveDistributionSelection(manifest, [], ['runtime.preset']),
      /distribution-dependency-missing:runtime\.preset:registry\.ci-github/,
    );
    const cyclic = structuredClone(manifest);
    cyclic.assets.find((asset) => asset.id === 'registry.ci-github').dependencies.push('runtime.preset');
    assert.throws(() => resolveDistributionSelection(cyclic, ['quality-gate'], []), /distribution-dependency-cycle/);
    const directAssets = resolveDistributionSelection(
      manifest,
      [],
      ['runtime.preset', 'registry.ci-github'],
    );
    assert.deepEqual(directAssets.map((asset) => asset.id), ['registry.ci-github', 'runtime.preset']);
  });
});

// contract_id: contract.ci-selective-distribution.delivery
// contract_id: contract.ci-selective-distribution.application
test('fetch, plan, apply and rollback preserve explicit consumer state transitions', async () => {
  await withFixture('a3-ci-github-distribution-lifecycle-', async (root) => {
      const release = prepareRelease(root);
      const projectRoot = path.join(root, 'consumer');
      fs.mkdirSync(projectRoot);
      const existingFile = path.join(projectRoot, 'README.md');
      fs.writeFileSync(existingFile, 'consumer-owned documentation\n');
      const fetched = await fetchDistribution({
        projectRoot,
        manifest: release.manifest,
        manifestBytes: release.manifestBytes,
        requestedPresets: ['quality-gate'],
        requestedAssets: [],
        sourceRoot: repositoryRoot,
      });
      assert.equal(fetched.action, 'fetched');
      assert.ok(fs.existsSync(path.join(fetched.distributionRoot, 'runtime/preset/run-validate-ci-preset.mjs')));
      assert.equal(verifyFetchedDistribution({ projectRoot, sourceRevision }).status, 'verified');
      const plan = planDistributionApplication({
        projectRoot,
        sourceRevision,
        requestedPresets: ['quality-gate'],
        requestedAssets: [],
      });
      assert.deepEqual(plan.actions.map((entry) => entry.action), ['create']);
      const applied = applyDistributionPlan({
        projectRoot,
        planPath: plan.planPath,
        approvalDigest: plan.planDigest,
      });
      const workflow = path.join(projectRoot, '.github/workflows/quality-gate.yml');
      assert.equal(applied.status, 'applied');
      assert.ok(fs.existsSync(workflow));
      assert.ok(applied.nextSteps.includes('preflight'));
      const ordinaryFiles = (directory) => fs.readdirSync(directory, { withFileTypes: true })
        .filter((entry) => directory !== projectRoot || entry.name !== '.a3-skills')
        .flatMap((entry) => entry.isDirectory()
          ? ordinaryFiles(path.join(directory, entry.name))
          : [path.relative(projectRoot, path.join(directory, entry.name)).split(path.sep).join('/')]);
      assert.deepEqual(ordinaryFiles(projectRoot).sort(), ['.github/workflows/quality-gate.yml', 'README.md']);
      assert.equal(fs.readFileSync(existingFile, 'utf8'), 'consumer-owned documentation\n');
      assert.doesNotMatch(fs.readFileSync(workflow, 'utf8'), /\.a3-skills\//);
      const rolledBack = rollbackDistributionTransaction({ projectRoot, transactionId: applied.transactionId });
      assert.equal(rolledBack.status, 'rolled-back');
      assert.equal(rolledBack.rollbackStatus, 'restored');
      assert.equal(fs.existsSync(workflow), false);
      assert.equal(fs.readFileSync(existingFile, 'utf8'), 'consumer-owned documentation\n');
      const configurations = {
        '.ci/platform-manifest.yml': 'platforms: [{id: linux-x64, runner: ubuntu-24.04, target: x86_64-unknown-linux-gnu}]\n',
        '.ci/quality-platforms.yml': 'platforms: [{id: linux-x64}]\n',
      };
      fs.mkdirSync(path.join(projectRoot, '.ci'), { recursive: true });
      for (const [relative, text] of Object.entries(configurations)) {
        fs.writeFileSync(path.join(projectRoot, relative), text);
      }
      const optionalSelection = {
        requestedPresets: ['quality-gate'], requestedAssets: ['workflow.quality-gate-platforms', 'runtime.quality-platforms-workflow'],
      };
      await fetchDistribution({ projectRoot, manifest: release.manifest, manifestBytes: release.manifestBytes,
        sourceRoot: repositoryRoot, ...optionalSelection });
      const optionalPlan = planDistributionApplication({ projectRoot, sourceRevision, ...optionalSelection });
      const optionalApplied = applyDistributionPlan({ projectRoot, planPath: optionalPlan.planPath, approvalDigest: optionalPlan.planDigest });
      assert.deepEqual(ordinaryFiles(projectRoot).sort(), [
        '.ci/platform-manifest.yml', '.ci/quality-platforms.yml',
        '.github/workflows/quality-gate-platforms.yml', '.github/workflows/quality-gate.yml', 'README.md',
      ]);
      const optionalWorkflow = fs.readFileSync(path.join(projectRoot, '.github/workflows/quality-gate-platforms.yml'), 'utf8');
      assert.match(optionalWorkflow, /uses: a3-suite\/a3-ci-github\/\.github\/workflows\/ci-quality-platforms.yml@<quality-platforms-workflow-sha>/);
      assert.doesNotMatch(optionalWorkflow, /ci-platform-matrix@|id: trusted-assets/);
      assert.doesNotMatch(optionalWorkflow, /CoreLoader|pyyaml|\.a3-skills\//);
      for (const [relative, text] of Object.entries(configurations)) {
        assert.equal(fs.readFileSync(path.join(projectRoot, relative), 'utf8'), text);
      }
      assert.equal(fs.readFileSync(existingFile, 'utf8'), 'consumer-owned documentation\n');
      assert.equal(rollbackDistributionTransaction({ projectRoot, transactionId: optionalApplied.transactionId }).status, 'rolled-back');
      assert.deepEqual(ordinaryFiles(projectRoot).sort(), ['.ci/platform-manifest.yml', '.ci/quality-platforms.yml', 'README.md']);
      const releaseSelection = { requestedPresets: ['release-request', 'release-publication'], requestedAssets: [] };
      await fetchDistribution({ projectRoot, manifest: release.manifest, manifestBytes: release.manifestBytes,
        sourceRoot: repositoryRoot, ...releaseSelection });
      const releasePlan = planDistributionApplication({ projectRoot, sourceRevision, ...releaseSelection });
      const releaseApplied = applyDistributionPlan({ projectRoot, planPath: releasePlan.planPath, approvalDigest: releasePlan.planDigest });
      assert.deepEqual(ordinaryFiles(projectRoot).sort(), [
        '.ci/platform-manifest.yml', '.ci/quality-platforms.yml',
        '.github/workflows/release-publication-caller.yml', '.github/workflows/release-publication-request.yml',
        '.github/workflows/release-request-tag.yml', 'README.md',
      ]);
      assert.equal(fs.existsSync(path.join(projectRoot, '.github/workflows/release-publication.yml')), false);
      const publication = fs.readFileSync(path.join(projectRoot, '.github/workflows/release-publication-caller.yml'), 'utf8');
      assert.match(publication, /ci-release-publication\.yml@<release-publication-workflow-sha>/);
      assert.doesNotMatch(publication, /\.a3-skills\//);
      assert.equal(fs.readFileSync(existingFile, 'utf8'), 'consumer-owned documentation\n');
      assert.equal(rollbackDistributionTransaction({ projectRoot, transactionId: releaseApplied.transactionId }).status, 'rolled-back');
      assert.deepEqual(ordinaryFiles(projectRoot).sort(), ['.ci/platform-manifest.yml', '.ci/quality-platforms.yml', 'README.md']);
      const packageSelection = { requestedPresets: ['package-publication'], requestedAssets: [] };
      await fetchDistribution({ projectRoot, manifest: release.manifest, manifestBytes: release.manifestBytes,
        sourceRoot: repositoryRoot, ...packageSelection });
      const packagePlan = planDistributionApplication({ projectRoot, sourceRevision, ...packageSelection });
      const packageApplied = applyDistributionPlan({ projectRoot, planPath: packagePlan.planPath, approvalDigest: packagePlan.planDigest });
      assert.deepEqual(ordinaryFiles(projectRoot).sort(), [
        '.ci/platform-manifest.yml', '.ci/quality-platforms.yml',
        '.github/workflows/package-publication-caller.yml', '.github/workflows/package-publication-request.yml', 'README.md',
      ]);
      assert.equal(fs.existsSync(path.join(projectRoot, '.github/workflows/package-publication.yml')), false);
      assert.equal(fs.existsSync(path.join(projectRoot, '.github/workflows/package-preparation.yml')), false);
      const packageCaller = fs.readFileSync(path.join(projectRoot, '.github/workflows/package-publication-caller.yml'), 'utf8');
      assert.match(packageCaller, /ci-package-publication\.yml@<package-publication-workflow-sha>/);
      assert.equal(fs.readFileSync(existingFile, 'utf8'), 'consumer-owned documentation\n');
      assert.equal(rollbackDistributionTransaction({ projectRoot, transactionId: packageApplied.transactionId }).status, 'rolled-back');
      assert.deepEqual(ordinaryFiles(projectRoot).sort(), ['.ci/platform-manifest.yml', '.ci/quality-platforms.yml', 'README.md']);

  });
});

// contract_id: contract.ci-selective-distribution.application
test('plan rejects unmanaged destination drift and apply rejects changed plan inputs', async () => {
  await withFixture('a3-ci-github-distribution-conflict-', async (root) => {
      const release = prepareRelease(root);
      const projectRoot = path.join(root, 'consumer');
      fs.mkdirSync(path.join(projectRoot, '.github/workflows'), { recursive: true });
      await fetchDistribution({
        projectRoot,
        manifest: release.manifest,
        manifestBytes: release.manifestBytes,
        requestedPresets: ['quality-gate'],
        requestedAssets: [],
        sourceRoot: repositoryRoot,
      });
      const workflow = path.join(projectRoot, '.github/workflows/quality-gate.yml');
      fs.writeFileSync(workflow, 'name: consumer-owned\n');
      const conflict = planDistributionApplication({
        projectRoot,
        sourceRevision,
        requestedPresets: ['quality-gate'],
        requestedAssets: [],
      });
      assert.deepEqual(conflict.actions.map((entry) => entry.action), ['conflict']);
      assert.throws(
        () => applyDistributionPlan({ projectRoot, planPath: conflict.planPath, approvalDigest: conflict.planDigest }),
        /distribution-plan-has-conflicts/,
      );
      fs.rmSync(workflow);
      const plan = planDistributionApplication({
        projectRoot,
        sourceRevision,
        requestedPresets: ['quality-gate'],
        requestedAssets: [],
      });
      fs.writeFileSync(workflow, 'name: changed-after-plan\n');
      assert.throws(
        () => applyDistributionPlan({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest }),
        /distribution-plan-input-changed/,
      );
  });
});

// contract_id: contract.ci-selective-distribution.delivery
test('fetch rejects source bytes that do not match the release manifest', async () => {
  await withFixture('a3-ci-github-distribution-integrity-', async (root) => {
    const release = prepareRelease(root);
    const projectRoot = path.join(root, 'consumer');
    fs.mkdirSync(projectRoot);
    const manifest = structuredClone(release.manifest);
    manifest.files['workflows/quality/quality-gate.yml'].sha256 = '0'.repeat(64);
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(
      fetchDistribution({
        projectRoot,
        manifest,
        manifestBytes,
        requestedPresets: [],
        requestedAssets: ['workflow.quality-gate', 'runtime.quality-workflow', 'runtime.preset', 'registry.ci-github'],
        sourceRoot: repositoryRoot,
      }),
      /distribution-file-integrity-mismatch/,
    );
    assert.equal(fs.existsSync(path.join(projectRoot, '.a3-skills/ci-github/distributions', sourceRevision)), false);
  });
});

// contract_id: contract.ci-selective-distribution.delivery
test('fetch rejects a project-local state path redirected through a symlink', async () => {
  await withFixture('a3-ci-github-distribution-symlink-state-', async (root) => {
    const release = prepareRelease(root);
    const projectRoot = path.join(root, 'consumer');
    const externalRoot = path.join(root, 'external');
    fs.mkdirSync(path.join(projectRoot, '.a3-skills/ci-github'), { recursive: true });
    fs.mkdirSync(externalRoot);
    fs.symlinkSync(externalRoot, path.join(projectRoot, '.a3-skills/ci-github/distributions'));
    await assert.rejects(
      fetchDistribution({
        projectRoot,
        manifest: release.manifest,
        manifestBytes: release.manifestBytes,
        requestedPresets: ['quality-gate'],
        requestedAssets: [],
        sourceRoot: repositoryRoot,
      }),
      /distribution-local-root-outside-project/,
    );
    assert.deepEqual(fs.readdirSync(externalRoot), []);
  });
});

// contract_id: contract.ci-selective-distribution.delivery
test('local verification rejects distribution bytes changed after fetch', async () => {
  await withFixture('a3-ci-github-distribution-local-integrity-', async (root) => {
    const release = prepareRelease(root);
    const projectRoot = path.join(root, 'consumer');
    fs.mkdirSync(projectRoot);
    const fetched = await fetchDistribution({
      projectRoot,
      manifest: release.manifest,
      manifestBytes: release.manifestBytes,
      requestedPresets: [],
      requestedAssets: ['workflow.quality-gate', 'runtime.quality-workflow', 'runtime.preset', 'registry.ci-github'],
      sourceRoot: repositoryRoot,
    });
    fs.writeFileSync(path.join(fetched.distributionRoot, 'workflows/quality/quality-gate.yml'), 'tampered\n');
    assert.throws(
      () => verifyFetchedDistribution({ projectRoot, sourceRevision }),
      /distribution-local-file-integrity-mismatch/,
    );
  });
});

// contract_id: contract.ci-selective-distribution.selection
// contract_id: contract.ci-selective-distribution.application
test('direct workflow asset fetch cannot bypass preset closure during apply planning', async () => {
  await withFixture('a3-ci-github-distribution-direct-workflow-', async (root) => {
    const release = prepareRelease(root);
    const projectRoot = path.join(root, 'consumer');
    fs.mkdirSync(projectRoot);
    await fetchDistribution({
      projectRoot,
      manifest: release.manifest,
      manifestBytes: release.manifestBytes,
      requestedPresets: [],
      requestedAssets: ['workflow.quality-gate', 'runtime.quality-workflow', 'runtime.preset', 'registry.ci-github'],
      sourceRoot: repositoryRoot,
    });
    assert.throws(
      () => planDistributionApplication({
        projectRoot,
        sourceRevision,
        requestedPresets: [],
        requestedAssets: ['workflow.quality-gate', 'runtime.quality-workflow', 'runtime.preset', 'registry.ci-github'],
      }),
      /distribution-copy-requires-matching-preset:workflow\.quality-gate/,
    );
    await fetchDistribution({
      projectRoot,
      manifest: release.manifest,
      manifestBytes: release.manifestBytes,
      requestedPresets: ['release-request'],
      requestedAssets: [],
      sourceRoot: repositoryRoot,
    });
    assert.throws(
      () => planDistributionApplication({
        projectRoot,
        sourceRevision,
        requestedPresets: ['release-request'],
        requestedAssets: ['workflow.quality-gate', 'runtime.quality-workflow', 'runtime.preset', 'registry.ci-github'],
      }),
      /distribution-copy-requires-matching-preset:workflow\.quality-gate/,
    );
    await fetchDistribution({
      projectRoot,
      manifest: release.manifest,
      manifestBytes: release.manifestBytes,
      requestedPresets: ['quality-gate'],
      requestedAssets: ['workflow.quality-gate-platforms', 'runtime.quality-platforms-workflow'],
      sourceRoot: repositoryRoot,
    });
    const optionalPlan = planDistributionApplication({
      projectRoot,
      sourceRevision,
      requestedPresets: ['quality-gate'],
      requestedAssets: ['workflow.quality-gate-platforms', 'runtime.quality-platforms-workflow'],
    });
    assert.ok(optionalPlan.actions.some((entry) => entry.assetId === 'workflow.quality-gate-platforms'));
  });
});

// contract_id: contract.ci-selective-distribution.application
test('apply rechecks destination ancestry immediately before writing', async () => {
  await withFixture('a3-ci-github-distribution-apply-symlink-', async (root) => {
    const release = prepareRelease(root);
    const projectRoot = path.join(root, 'consumer');
    const externalRoot = path.join(root, 'external');
    fs.mkdirSync(projectRoot);
    fs.mkdirSync(externalRoot);
    await fetchDistribution({
      projectRoot,
      manifest: release.manifest,
      manifestBytes: release.manifestBytes,
      requestedPresets: ['quality-gate'],
      requestedAssets: [],
      sourceRoot: repositoryRoot,
    });
    const plan = planDistributionApplication({
      projectRoot,
      sourceRevision,
      requestedPresets: ['quality-gate'],
      requestedAssets: [],
    });
    assert.throws(
      () => applyDistributionPlan({
        projectRoot,
        planPath: plan.planPath,
        approvalDigest: plan.planDigest,
        beforeWrite: () => fs.symlinkSync(externalRoot, path.join(projectRoot, '.github')),
      }),
      /distribution-destination-outside-root/,
    );
    assert.deepEqual(fs.readdirSync(externalRoot), []);
  });
});

// contract_id: contract.ci-selective-distribution.application
test('partial apply failure restores files changed earlier in the transaction', async () => {
  await withFixture('a3-ci-github-distribution-partial-', async (root) => {
    const release = prepareRelease(root);
    const projectRoot = path.join(root, 'consumer');
    fs.mkdirSync(projectRoot);
    await fetchDistribution({
      projectRoot,
      manifest: release.manifest,
      manifestBytes: release.manifestBytes,
      requestedPresets: ['release-publication'],
      requestedAssets: [],
      sourceRoot: repositoryRoot,
    });
    const plan = planDistributionApplication({
      projectRoot,
      sourceRevision,
      requestedPresets: ['release-publication'],
      requestedAssets: [],
    });
    assert.ok(plan.actions.length > 1);
    const changedLater = plan.actions[1].destination;
    const changedPath = path.join(projectRoot, changedLater);
    assert.throws(
      () => applyDistributionPlan({
        projectRoot,
        planPath: plan.planPath,
        approvalDigest: plan.planDigest,
        beforeWrite: ({ index }) => {
          if (index !== 1) return;
          fs.mkdirSync(path.dirname(changedPath), { recursive: true });
          fs.writeFileSync(changedPath, 'changed-after-plan\n');
        },
      }),
      /distribution-plan-input-changed/,
    );
    assert.equal(fs.existsSync(path.join(projectRoot, plan.actions[0].destination)), false);
    assert.equal(fs.readFileSync(changedPath, 'utf8'), 'changed-after-plan\n');
    const transactionsRoot = path.join(projectRoot, '.a3-skills/ci-github/transactions');
    const transactionDirectories = fs.readdirSync(transactionsRoot);
    assert.equal(transactionDirectories.length, 1);
    const transaction = JSON.parse(fs.readFileSync(
      path.join(transactionsRoot, transactionDirectories[0], 'transaction.json'),
      'utf8',
    ));
    assert.equal(transaction.status, 'rolled-back');
    assert.equal(transaction.actions[0].state, 'restored');
    assert.equal(transaction.actions[1].state, 'not-applied');
    transaction.status = 'rollback-required';
    const transactionPath = path.join(transactionsRoot, transactionDirectories[0], 'transaction.json');
    fs.writeFileSync(transactionPath, `${JSON.stringify(transaction, null, 2)}\n`);
    assert.equal(rollbackDistributionTransaction({
      projectRoot,
      transactionId: transaction.transactionId,
    }).status, 'rolled-back');
    assert.equal(fs.readFileSync(changedPath, 'utf8'), 'changed-after-plan\n');
  });
});

// contract_id: contract.ci-selective-distribution.application
test('application rejects invalid ownership approval and concurrent mutation locks', async () => {
  await withFixture('a3-ci-github-distribution-application-guards-', async (root) => {
    const release = prepareRelease(root);
    const projectRoot = path.join(root, 'consumer');
    fs.mkdirSync(projectRoot);
    await fetchDistribution({
      projectRoot,
      manifest: release.manifest,
      manifestBytes: release.manifestBytes,
      requestedPresets: ['quality-gate'],
      requestedAssets: [],
      sourceRoot: repositoryRoot,
    });
    const assetLockPath = path.join(projectRoot, '.ci/ci-assets.lock.json');
    fs.mkdirSync(path.dirname(assetLockPath), { recursive: true });
    fs.writeFileSync(assetLockPath, '{"schemaVersion":"1","kind":"invalid","assets":[]}\n');
    assert.throws(
      () => planDistributionApplication({
        projectRoot,
        sourceRevision,
        requestedPresets: ['quality-gate'],
        requestedAssets: [],
      }),
      /distribution-prior-asset-lock-invalid/,
    );
    fs.rmSync(assetLockPath);
    const plan = planDistributionApplication({
      projectRoot,
      sourceRevision,
      requestedPresets: ['quality-gate'],
      requestedAssets: [],
    });
    assert.throws(
      () => applyDistributionPlan({ projectRoot, planPath: plan.planPath, approvalDigest: '0'.repeat(64) }),
      /distribution-plan-approval-invalid/,
    );
    fs.mkdirSync(path.dirname(assetLockPath), { recursive: true });
    fs.writeFileSync(assetLockPath, '{}\n');
    assert.throws(
      () => applyDistributionPlan({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest }),
      /distribution-plan-ownership-changed/,
    );
    fs.rmSync(assetLockPath);
    const mutationLock = path.join(projectRoot, '.a3-skills/ci-github/apply.lock');
    const transactionsPath = path.join(projectRoot, '.a3-skills/ci-github/transactions');
    const externalTransactions = path.join(root, 'external-transactions');
    fs.rmSync(transactionsPath, { recursive: true, force: true });
    fs.mkdirSync(externalTransactions);
    fs.symlinkSync(externalTransactions, transactionsPath);
    assert.throws(
      () => applyDistributionPlan({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest }),
      /distribution-transaction-root-outside-project/,
    );
    assert.equal(fs.existsSync(mutationLock), false);
    fs.rmSync(transactionsPath);
    fs.writeFileSync(mutationLock, 'occupied\n');
    assert.throws(
      () => applyDistributionPlan({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest }),
      /distribution-apply-locked/,
    );
    fs.rmSync(mutationLock);
    const applied = applyDistributionPlan({
      projectRoot,
      planPath: plan.planPath,
      approvalDigest: plan.planDigest,
    });
    fs.writeFileSync(mutationLock, 'occupied\n');
    assert.throws(
      () => rollbackDistributionTransaction({ projectRoot, transactionId: applied.transactionId }),
      /distribution-apply-locked/,
    );
    fs.rmSync(mutationLock);
  });
});

// contract_id: contract.ci-selective-distribution.application
test('rollback validates every backup identity before changing consumer files', async () => {
  await withFixture('a3-ci-github-distribution-backup-integrity-', (root) => {
    const projectRoot = path.join(root, 'consumer');
    const transactionId = `1-${'a'.repeat(12)}`;
    const transactionRoot = path.join(projectRoot, '.a3-skills/ci-github/transactions', transactionId);
    const first = { destination: '.github/workflows/first.yml', before: 'first-before\n', after: 'first-after\n' };
    const second = { destination: '.github/workflows/second.yml', before: 'second-before\n', after: 'second-after\n' };
    for (const entry of [first, second]) {
      const destination = path.join(projectRoot, entry.destination);
      const backup = path.join(transactionRoot, 'before', entry.destination);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.writeFileSync(destination, entry.after);
      fs.writeFileSync(backup, entry.before);
    }
    fs.writeFileSync(path.join(transactionRoot, 'before', second.destination), 'tampered\n');
    fs.writeFileSync(path.join(transactionRoot, 'transaction.json'), `${JSON.stringify({
      schemaVersion: '1',
      kind: 'a3-ci-github-distribution-transaction',
      transactionId,
      planDigest: 'b'.repeat(64),
      sourceRevision,
      status: 'applied',
      actions: [first, second].map((entry) => ({
        destination: entry.destination,
        beforeSha256: sha256(Buffer.from(entry.before)),
        afterSha256: sha256(Buffer.from(entry.after)),
        state: 'applied',
      })),
    }, null, 2)}\n`);
    assert.throws(
      () => rollbackDistributionTransaction({ projectRoot, transactionId }),
      /distribution-backup-integrity-mismatch/,
    );
    assert.equal(fs.readFileSync(path.join(projectRoot, first.destination), 'utf8'), first.after);
    fs.writeFileSync(path.join(transactionRoot, 'before', second.destination), second.before);
    const transactionPath = path.join(transactionRoot, 'transaction.json');
    const interrupted = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
    interrupted.status = 'applying';
    interrupted.actions[0].state = 'restored';
    fs.writeFileSync(path.join(projectRoot, first.destination), first.before);
    fs.writeFileSync(transactionPath, `${JSON.stringify(interrupted, null, 2)}\n`);
    assert.equal(
      rollbackDistributionTransaction({ projectRoot, transactionId }).status,
      'rolled-back',
    );
    assert.equal(fs.readFileSync(path.join(projectRoot, second.destination), 'utf8'), second.before);
  });
});

// contract_id: contract.ci-selective-distribution.application
test('rollback refuses to overwrite consumer changes made after apply', async () => {
  await withFixture('a3-ci-github-distribution-rollback-conflict-', async (root) => {
    const release = prepareRelease(root);
    const projectRoot = path.join(root, 'consumer');
    fs.mkdirSync(projectRoot);
    await fetchDistribution({
      projectRoot,
      manifest: release.manifest,
      manifestBytes: release.manifestBytes,
      requestedPresets: ['quality-gate'],
      requestedAssets: [],
      sourceRoot: repositoryRoot,
    });
    const plan = planDistributionApplication({
      projectRoot,
      sourceRevision,
      requestedPresets: ['quality-gate'],
      requestedAssets: [],
    });
    const applied = applyDistributionPlan({
      projectRoot,
      planPath: plan.planPath,
      approvalDigest: plan.planDigest,
    });
    const workflow = path.join(projectRoot, '.github/workflows/quality-gate.yml');
    fs.writeFileSync(workflow, 'name: edited-after-apply\n');
    assert.throws(
      () => rollbackDistributionTransaction({ projectRoot, transactionId: applied.transactionId }),
      /distribution-rollback-destination-changed/,
    );
    assert.equal(fs.readFileSync(workflow, 'utf8'), 'name: edited-after-apply\n');
  });
});

// contract_id: contract.ci-selective-distribution.delivery
// contract_id: contract.ci-selective-distribution.application
test('standalone public CLI executes the local fetch plan and approved apply boundary', async () => {
  await withFixture('a3-ci-github-distribution-cli-', (root) => {
    const release = prepareRelease(root);
    const projectRoot = path.join(root, 'consumer');
    fs.mkdirSync(projectRoot);
    const cli = path.join(repositoryRoot, 'runtime/distribution/fetch-a3-ci-github.mjs');
    const fetchResult = spawnSync(process.execPath, [
      cli, 'fetch',
      '--manifest', release.manifestPath,
      '--source-root', repositoryRoot,
      '--preset', 'quality-gate',
      '--repo-root', projectRoot,
    ], { encoding: 'utf8' });
    assert.equal(fetchResult.status, 0, fetchResult.stderr);
    const fetched = JSON.parse(fetchResult.stdout);
    assert.equal(fetched.sourceRevision, sourceRevision);
    const verifyResult = spawnSync(process.execPath, [
      cli, 'verify',
      '--source-revision', sourceRevision,
      '--repo-root', projectRoot,
    ], { encoding: 'utf8' });
    assert.equal(verifyResult.status, 0, verifyResult.stderr);
    assert.equal(JSON.parse(verifyResult.stdout).status, 'verified');
    const planResult = spawnSync(process.execPath, [
      cli, 'plan',
      '--source-revision', sourceRevision,
      '--preset', 'quality-gate',
      '--repo-root', projectRoot,
    ], { encoding: 'utf8' });
    assert.equal(planResult.status, 0, planResult.stderr);
    const plan = JSON.parse(planResult.stdout);
    const applyResult = spawnSync(process.execPath, [
      cli, 'apply',
      '--plan', plan.planPath,
      '--approve', plan.planDigest,
      '--repo-root', projectRoot,
    ], { encoding: 'utf8' });
    assert.equal(applyResult.status, 0, applyResult.stderr);
    assert.equal(JSON.parse(applyResult.stdout).status, 'applied');
  });
});

// contract_id: contract.ci-selective-distribution.delivery
test('standalone public CLI executes through an absolute symlinked path', async () => {
  await withFixture('a3-ci-github-distribution-cli-symlink-', (root) => {
    const cli = path.join(repositoryRoot, 'runtime/distribution/fetch-a3-ci-github.mjs');
    const link = path.join(root, 'fetch-a3-ci-github.mjs');
    fs.symlinkSync(cli, link);
    const result = spawnSync(process.execPath, [link, 'unknown-command'], { encoding: 'utf8' });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /distribution-command-unknown/);
  });
});

// contract_id: contract.ci-selective-distribution.delivery
test('same revision merges separately fetched verified asset groups without replacing prior files', async () => {
  await withFixture('a3-ci-github-distribution-merge-', async (root) => {
      const release = prepareRelease(root);
      const projectRoot = path.join(root, 'consumer');
      fs.mkdirSync(projectRoot);
      await fetchDistribution({
        projectRoot,
        manifest: release.manifest,
        manifestBytes: release.manifestBytes,
        requestedPresets: [],
        requestedAssets: ['registry.ci-github'],
        sourceRoot: repositoryRoot,
      });
      const merged = await fetchDistribution({
        projectRoot,
        manifest: release.manifest,
        manifestBytes: release.manifestBytes,
        requestedPresets: [],
        requestedAssets: ['lint.github-actions'],
        sourceRoot: repositoryRoot,
      });
      assert.equal(merged.action, 'merged');
      assert.deepEqual(merged.selectedAssets, ['lint.github-actions', 'registry.ci-github']);
      assert.ok(fs.existsSync(path.join(merged.distributionRoot, 'skills/ci-github/references/ci-distribution-assets.reference.yml')));
      assert.ok(fs.existsSync(path.join(merged.distributionRoot, 'lint-rules/a3-lint/ci_github_workflow_name_matches_file.lua')));
  });
});

// contract_id: contract.ci-selective-distribution.delivery
test('selected distribution runs preflight and lock without materializer and supports its later acquisition', async () => {
  await withFixture('a3-ci-github-distribution-runtime-', async (root) => {
    const release = prepareRelease(root);
    const projectRoot = path.join(root, 'consumer');
    fs.mkdirSync(projectRoot);
    const runtimeRoot = path.join(repositoryRoot, 'runtime/preset');
    const run = (script) => {
      const scriptPath = path.join(root, 'check.mts');
      fs.writeFileSync(scriptPath, script);
      const result = spawnSync(tsx, [scriptPath], { encoding: 'utf8', env: {
        ...process.env, CI_GITHUB_PREFLIGHT_RUNTIME_ROOT: runtimeRoot, CI_FIXED_RUNTIME_ROOT: runtimeRoot,
      } });
      assert.equal(result.status, 0, result.stderr);
    };
    const request = await fetchDistribution({ projectRoot, manifest: release.manifest,
      manifestBytes: release.manifestBytes, requestedPresets: ['release-request'], requestedAssets: [], sourceRoot: repositoryRoot });
    const model = loadReleaseRequestFixtureModel({ repositoryRoot: request.distributionRoot, runtimeRoot });
    writeReleaseRequestFixture({ repositoryRoot: request.distributionRoot, root: projectRoot, model });
    const moduleUrl = (distributionRoot, relative) => JSON.stringify(pathToFileURL(path.join(distributionRoot, relative)).href);
    run(`import assert from 'node:assert/strict';
      import { writeCiAssetLock } from ${moduleUrl(request.distributionRoot, 'runtime/preset/ci-asset-lock-plan.ts')};
      import { validateCiPreset } from ${moduleUrl(request.distributionRoot, 'runtime/preset/validate-ci-preset.ts')};
      const lock = writeCiAssetLock({ repoRoot: ${JSON.stringify(projectRoot)}, sourceRevision: ${JSON.stringify(sourceRevision)} });
      assert.equal(lock.assets.length, 1);
      assert.equal(validateCiPreset({ repoRoot: ${JSON.stringify(projectRoot)}, presets: ['release-request'] }).status, 'success');`);
    const quality = await fetchDistribution({ projectRoot, manifest: release.manifest,
      manifestBytes: release.manifestBytes, requestedPresets: ['quality-gate'], requestedAssets: [], sourceRoot: repositoryRoot });
    const materializer = path.join(quality.distributionRoot, 'runtime/adapter/materialize-adapter-bundle.ts');
    assert.equal(fs.existsSync(materializer), false);
    run(`import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { resolveQualityWorkflow } from ${moduleUrl(quality.distributionRoot, 'runtime/preset/ci-preset-assets.ts')};
      import { loadRegistry } from ${moduleUrl(quality.distributionRoot, 'runtime/preset/preset-registry.ts')};
      const report = { missingSettings: [], mismatches: [] };
      const registry = loadRegistry(report);
      assert.deepEqual(report.mismatches, []);
      const workflow = { jobs: { quality: { uses: registry.actionRepository + '/' + registry.qualityReusableWorkflow.source + '@' + 'a'.repeat(40), with: { 'toolchain-version': '24.0.0' } } } };
      assert.equal(resolveQualityWorkflow(workflow, registry, report).env.CI_TOOLCHAIN_VERSION, '24.0.0');
      const source = ${JSON.stringify(path.join(quality.distributionRoot, '.github/workflows/ci-quality.yml'))};
      fs.unlinkSync(source);
      resolveQualityWorkflow(workflow, registry, report);
      assert.ok(report.mismatches.some(item => item.message === 'fixed quality reusable workflow source is missing'));`);
    fs.copyFileSync(path.join(repositoryRoot, '.github/workflows/ci-quality.yml'), path.join(quality.distributionRoot, '.github/workflows/ci-quality.yml'));
    const before = verifyFetchedDistribution({ projectRoot, sourceRevision });
    const merged = await fetchDistribution({ projectRoot, manifest: release.manifest,
      manifestBytes: release.manifestBytes, requestedPresets: ['quality-gate'], requestedAssets: ['runtime.adapter-materializer'], sourceRoot: repositoryRoot });
    assert.equal(merged.action, 'merged');
    assert.ok(fs.existsSync(materializer));
    assert.equal(verifyFetchedDistribution({ projectRoot, sourceRevision }).status, before.status);
    const adapterProject = path.join(root, 'adapter-consumer');
    fs.mkdirSync(adapterProject);
    fs.writeFileSync(path.join(adapterProject, 'package.json'), JSON.stringify({ scripts: Object.fromEntries(['format:check', 'lint', 'typecheck', 'test'].map(name => [name, 'node --version'])) }));
    fs.writeFileSync(path.join(adapterProject, 'package-lock.json'), '{}');
    const beforeFiles = fs.readdirSync(adapterProject);
    run(`import assert from 'node:assert/strict';
      import { materializeAdapterBundle } from ${moduleUrl(merged.distributionRoot, 'runtime/adapter/materialize-adapter-bundle.ts')};
      const result = materializeAdapterBundle({ sourceRoot: ${JSON.stringify(adapterProject)}, inventoryPath: 'skills/ci-github/references/ci-script-assets.reference.yml', bundleId: 'typescript-npm-quality', targetRoot: ${JSON.stringify(adapterProject)} });
      assert.deepEqual(result.files, []);
      assert.equal(result.binding.standardBundleId, 'typescript-npm-quality');`);
    assert.deepEqual(fs.readdirSync(adapterProject), beforeFiles);
  });
});

// evidence_role: contract
// test_level: integration
// contract_id: contract.ci-selective-distribution.delivery
// integration_id: selective-distribution-delivery
test('remote fetch rejects invalid redirect and transport responses without publishing consumer assets', async () => {
  // Arrange
  await withFixture('distribution-remote-rejection-', async (root) => {
    const release = prepareRelease(root);
    const projectRoot = path.join(root, 'consumer');
    const stateRoot = path.join(projectRoot, '.a3-skills/ci-github');
    fs.mkdirSync(stateRoot, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'README.md'), 'project-owned content');
    const before = snapshotTree(projectRoot);
    const originalFetch = globalThis.fetch;
    const cases = [
      ['missing Location', { status: 302, location: null }, /distribution-download-redirect-location-missing/],
      ['untrusted redirect', { status: 302, location: 'https://example.invalid/asset' }, /distribution-download-redirect-untrusted/],
      ['insecure redirect', { status: 302, location: 'http://raw.githubusercontent.com/asset' }, /distribution-download-redirect-untrusted/],
      ['HTTP failure', { status: 404, location: null }, /http-404/],
      ['opaque transport failure', { failure: 'transport unavailable' }, /transport unavailable/],
    ];
    try {
      for (const [label, response, diagnostic] of cases) {
        const requests = [];
        globalThis.fetch = async (url) => {
          requests.push(String(url));
          if (response.failure) throw response.failure;
          return { ok: false, status: response.status, headers: { get: () => response.location } };
        };
        // Act / Assert
        await assert.rejects(fetchDistribution({
          projectRoot, manifest: release.manifest, manifestBytes: release.manifestBytes,
          requestedPresets: ['quality-gate'], requestedAssets: [],
        }), diagnostic, label);
        assert.ok(requests.length > 0, label);
        assert.ok(requests.every((url) => url.startsWith(`${release.manifest.rawOrigin}/${release.manifest.repository}/${sourceRevision}/`)), label);
        assert.deepEqual(snapshotTree(projectRoot), before, label);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// evidence_role: contract
// test_level: integration
// contract_id: contract.ci-selective-distribution.application
// integration_id: selective-distribution-application
test('plan rejects malformed prior ownership locks before changing consumer state', async () => {
  // Arrange
  await withFixture('distribution-prior-lock-', async (root) => {
    const release = prepareRelease(root);
    const projectRoot = path.join(root, 'consumer');
    fs.mkdirSync(projectRoot);
    await fetchDistribution({ projectRoot, manifest: release.manifest, manifestBytes: release.manifestBytes,
      requestedPresets: ['quality-gate'], requestedAssets: [], sourceRoot: repositoryRoot });
    const lockPath = path.join(projectRoot, '.ci/ci-assets.lock.json');
    fs.mkdirSync(path.dirname(lockPath));
    const valid = { schemaVersion: '1', kind: 'ci-github-asset-lock', sourceRevision,
      assets: [{ path: '.github/workflows/quality-gate.yml', appliedSha256: 'a'.repeat(64) }] };
    const cases = [
      ['schema', (lock) => { lock.schemaVersion = '2'; }],
      ['revision', (lock) => { lock.sourceRevision = 'main'; }],
      ['missing revision', (lock) => { delete lock.sourceRevision; }],
      ['assets type', (lock) => { lock.assets = {}; }],
      ['missing assets', (lock) => { delete lock.assets; }],
      ['null entry', (lock) => { lock.assets = [null]; }],
      ['path type', (lock) => { lock.assets[0].path = 42; }],
      ['duplicate path', (lock) => { lock.assets.push({ ...lock.assets[0] }); }],
      ['digest', (lock) => { lock.assets[0].appliedSha256 = 'invalid'; }],
      ['missing digest', (lock) => { delete lock.assets[0].appliedSha256; }],
    ];
    for (const [label, mutate] of cases) {
      const lock = structuredClone(valid);
      mutate(lock);
      fs.writeFileSync(lockPath, JSON.stringify(lock));
      const before = snapshotTree(projectRoot);
      // Act / Assert
      assert.throws(() => planDistributionApplication({ projectRoot, sourceRevision,
        requestedPresets: ['quality-gate'], requestedAssets: [] }), /distribution-prior-asset-lock-invalid/, label);
      assert.deepEqual(snapshotTree(projectRoot), before, label);
    }
  });
});

// evidence_role: contract
// test_level: integration
// contract_id: contract.ci-selective-distribution.application
// integration_id: selective-distribution-application
test('approved plans reuse identical workflows update owned bytes and reject unmanaged changes', async () => {
  // Arrange
  await withFixture('distribution-owned-update-', async (root) => {
    const release = prepareRelease(root);
    const projectRoot = path.join(root, 'consumer');
    fs.mkdirSync(projectRoot);
    const projectDocument = path.join(projectRoot, 'README.md');
    fs.writeFileSync(projectDocument, 'project-owned content');
    await fetchDistribution({ projectRoot, manifest: release.manifest, manifestBytes: release.manifestBytes,
      requestedPresets: ['quality-gate'], requestedAssets: [], sourceRoot: repositoryRoot });
    const options = { projectRoot, sourceRevision, requestedPresets: ['quality-gate'], requestedAssets: [] };
    const initial = planDistributionApplication(options);
    applyDistributionPlan({ projectRoot, planPath: initial.planPath, approvalDigest: initial.planDigest });
    const workflowPath = '.github/workflows/quality-gate.yml';
    const workflow = path.join(projectRoot, workflowPath);
    const canonical = fs.readFileSync(workflow);
    const lockPath = path.join(projectRoot, '.ci/ci-assets.lock.json');
    fs.mkdirSync(path.dirname(lockPath));
    const writeOwnership = (bytes) => fs.writeFileSync(lockPath, JSON.stringify({
      schemaVersion: '1', kind: 'ci-github-asset-lock', sourceRevision,
      generatedAt: '2026-01-01T00:00:00Z',
      assets: [{ path: workflowPath, canonicalSha256: sha256(canonical), appliedSha256: sha256(bytes) }],
    }));
    writeOwnership(canonical);
    const reuse = planDistributionApplication(options);
    let writes = 0;
    // Act
    const reused = applyDistributionPlan({ projectRoot, planPath: reuse.planPath, approvalDigest: reuse.planDigest,
      beforeWrite: () => { writes += 1; } });
    // Assert
    assert.deepEqual(reuse.actions.map((entry) => entry.action), ['reuse']);
    assert.equal(writes, 0);
    assert.deepEqual(fs.readFileSync(workflow), canonical);
    const reusedTransaction = path.join(projectRoot, '.a3-skills/ci-github/transactions', reused.transactionId);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(reusedTransaction, 'transaction.json'), 'utf8')).actions, []);
    rollbackDistributionTransaction({ projectRoot, transactionId: reused.transactionId });
    assert.deepEqual(fs.readFileSync(workflow), canonical);
    // Arrange
    const oldManagedBytes = Buffer.from('name: previously managed workflow\n');
    fs.writeFileSync(workflow, oldManagedBytes);
    writeOwnership(oldManagedBytes);
    const ownershipBefore = fs.readFileSync(lockPath);
    const update = planDistributionApplication(options);
    // Act
    const updated = applyDistributionPlan({ projectRoot, planPath: update.planPath, approvalDigest: update.planDigest });
    // Assert
    assert.deepEqual(update.actions.map((entry) => entry.action), ['update']);
    assert.deepEqual(fs.readFileSync(workflow), canonical);
    const transactionRoot = path.join(projectRoot, '.a3-skills/ci-github/transactions', updated.transactionId);
    assert.deepEqual(fs.readFileSync(path.join(transactionRoot, 'before', workflowPath)), oldManagedBytes);
    assert.deepEqual(fs.readFileSync(lockPath), ownershipBefore);
    // Act
    const rolledBack = rollbackDistributionTransaction({ projectRoot, transactionId: updated.transactionId });
    // Assert
    assert.equal(rolledBack.rollbackStatus, 'restored');
    assert.deepEqual(fs.readFileSync(workflow), oldManagedBytes);
    assert.deepEqual(fs.readFileSync(lockPath), ownershipBefore);
    assert.equal(fs.readFileSync(projectDocument, 'utf8'), 'project-owned content');
    // Arrange
    fs.writeFileSync(workflow, 'unmanaged project edit');
    const conflict = planDistributionApplication(options);
    const before = snapshotTree(projectRoot);
    // Act / Assert
    assert.deepEqual(conflict.actions.map((entry) => entry.action), ['conflict']);
    assert.throws(() => applyDistributionPlan({ projectRoot, planPath: conflict.planPath,
      approvalDigest: conflict.planDigest }), /distribution-plan-has-conflicts/);
    assert.deepEqual(snapshotTree(projectRoot), before);
  });
});
