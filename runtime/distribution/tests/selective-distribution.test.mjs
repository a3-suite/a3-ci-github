import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterAll, expect, test, vi, describe } from 'vitest';
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
  'skills/installer',
  'runtime/installer',
  'runtime/release-publication/selection.ts',
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
    filter: (candidate) => !candidate.split(path.sep).some((part) => ['node_modules', '__pycache__', 'tmp'].includes(part)) || candidate === source,
  });
}
const runFixtureGit = (args) => {
  const result = spawnSync('git', args, { cwd: committedSourceRoot, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
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
  expect(result.status, result.stderr).toBe(0);
  return {
    output,
    manifestPath: path.join(output, 'a3-ci-github-distribution-manifest.json'),
    manifestBytes: fs.readFileSync(path.join(output, 'a3-ci-github-distribution-manifest.json')),
    manifest: JSON.parse(fs.readFileSync(path.join(output, 'a3-ci-github-distribution-manifest.json'), 'utf8')),
  };
};

describe("contract.ci-selective-distribution.delivery", () => {
  describe("selective-distribution", () => {
    // contract_id: contract.ci-selective-distribution.delivery
    test('release generator derives deterministic selective assets and checksums from registries', async () => {
      await withFixture('a3-ci-github-distribution-release-', (root) => {
        const first = prepareRelease(root);
        const manifest = validateDistributionManifest(first.manifest);
        expect(manifest.sourceRevision).toBe(sourceRevision);
        expect(manifest.assets.some((asset) => asset.id === 'runtime.preset')).toBeTruthy();
        expect(manifest.assets.some((asset) => asset.id === 'workflow.quality-gate')).toBeTruthy();
        expect(manifest.files['skills/ci-github/references/ci-script-contracts.reference.yml']).toBeTruthy();
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
          expect(manifest.files[relative].sha256).toBe(sha256(bytes));
          expect(manifest.files[relative].size).toBe(bytes.length);
        }
        const publication = resolveDistributionSelection(manifest, ['release-publication'], []);
        const publicationFiles = publication.flatMap((asset) => asset.files.map((file) => file.sourcePath));
        const releaseEvidenceFiles = [
          'skills/ci-github/references/release-publication-evidence.reference.yml',
          'runtime/release-publication/evidence.schema.json',
        ];
        for (const relative of releaseEvidenceFiles) expect(publicationFiles.includes(relative)).toBeTruthy();
        for (const preset of ['quality-gate', 'release-request', 'package-publication']) {
          const files = resolveDistributionSelection(manifest, [preset], [])
            .flatMap((asset) => asset.files.map((file) => file.sourcePath));
          for (const relative of releaseEvidenceFiles) expect(files.includes(relative), `${preset}: ${relative}`).toBe(false);
        }
        expect(publicationFiles.includes('runtime/preset/action-availability.ts')).toBeTruthy();
        expect(publicationFiles.some((relative) => relative.startsWith('actions/'))).toBe(false);
        const packagePreset = manifest.presets.find((preset) => preset.id === 'package-publication');
        expect(packagePreset.requiredAssets.filter((id) => id.startsWith('workflow.')).sort()).toStrictEqual(['workflow.package-publication-caller', 'workflow.package-publication-request']);
        expect(manifest.assets.some((asset) => asset.id === 'workflow.package-preparation')).toBe(false);
        const quality = manifest.presets.find((preset) => preset.id === 'quality-gate');
        expect(quality.requiredAssets.includes('workflow.quality-gate')).toBeTruthy();
        expect(quality.requiredAssets.includes('runtime.preset')).toBeTruthy();
        expect(quality.optionalAssets.includes('workflow.quality-gate-platforms')).toBeTruthy();
        const checksums = fs.readFileSync(path.join(first.output, 'SHA256SUMS'), 'utf8');
        expect(checksums).toMatch(new RegExp(sha256(first.manifestBytes)));
        expect(checksums).toMatch(/fetch-a3-ci-github\.mjs/);
      });
    });
  });
});

describe("contract.ci-selective-distribution.selection", () => {
  describe("selective-distribution", () => {
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
          expect(selected.some((asset) => asset.id === 'runtime.adapter-materializer')).toBe(false);
          expect(selected.flatMap((asset) => asset.files.map((file) => file.sourcePath))
            .filter((source) => source.startsWith('.github/workflows/')).sort()).toStrictEqual(workflows.map((file) => `.github/workflows/${file}`).sort());
        }
        expect(() => resolveDistributionSelection(manifest, ['quality-gate'], ['workflow.quality-gate-platforms'])).toThrow(/distribution-dependency-missing:workflow.quality-gate-platforms:runtime.quality-platforms-workflow/);
        const platforms = resolveDistributionSelection(manifest, ['quality-gate'],
          ['workflow.quality-gate-platforms', 'runtime.quality-platforms-workflow']);
        expect(platforms.flatMap((asset) => asset.files.map((file) => file.sourcePath))
          .filter((source) => source.startsWith('.github/workflows/')).sort()).toStrictEqual(['.github/workflows/ci-quality-platforms.yml', '.github/workflows/ci-quality.yml']);
        expect(() => resolveDistributionSelection(manifest, [], ['runtime.adapter-materializer'])).toThrow(/distribution-dependency-missing:runtime.adapter-materializer:runtime.preset/);
      });
    });
  });
});

describe("contract.ci-selective-distribution.delivery", () => {
  describe("selective-distribution", () => {
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
          expect(result.status, result.stderr).toBe(0);
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
          expect(release.manifest.files[sourcePath].sha256).toBe(sha256(committedBytes));
          expect(release.manifest.files[sourcePath].sha256).not.toBe(sha256(Buffer.from('working-tree-only-change\n')));
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
        expect(invalidSha.status).toBe(2);
        expect(invalidSha.stderr).toMatch(/distribution-release-source-revision-invalid/);
        const invalidTag = execute([
          '--output-directory', path.join(root, 'invalid-tag'),
          '--source-revision', sourceRevision,
          '--release-tag', 'latest',
        ]);
        expect(invalidTag.status).toBe(2);
        expect(invalidTag.stderr).toMatch(/distribution-release-tag-invalid/);
        const versionMismatch = execute([
          '--output-directory', path.join(root, 'version-mismatch'),
          '--source-revision', sourceRevision,
          '--release-tag', 'v9.9.9',
        ]);
        expect(versionMismatch.status).toBe(2);
        expect(versionMismatch.stderr).toMatch(/distribution-release-version-mismatch/);
        const headMismatch = execute([
          '--output-directory', path.join(root, 'head-mismatch'),
          '--source-revision', 'e'.repeat(40),
          '--release-tag', releaseTag,
        ]);
        expect(headMismatch.status).toBe(2);
        expect(headMismatch.stderr).toMatch(/distribution-release-source-head-mismatch/);
        const existingOutput = path.join(root, 'existing');
        fs.mkdirSync(existingOutput);
        const outputConflict = execute([
          '--output-directory', existingOutput,
          '--source-revision', sourceRevision,
          '--release-tag', releaseTag,
        ]);
        expect(outputConflict.status).toBe(2);
        expect(outputConflict.stderr).toMatch(/distribution-release-output-exists/);
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
          expect(() => validateDistributionManifest(candidate)).toThrow(diagnostic);
        }
        const duplicate = structuredClone(manifest);
        duplicate.assets.push(structuredClone(duplicate.assets[0]));
        expect(() => validateDistributionManifest(duplicate)).toThrow(/distribution-manifest-asset-invalid/);
        const invalidFile = structuredClone(manifest);
        const sourcePath = invalidFile.assets[0].files[0].sourcePath;
        invalidFile.files[sourcePath].sha256 = 'invalid';
        expect(() => validateDistributionManifest(invalidFile)).toThrow(/distribution-manifest-file-invalid/);
        const unknownDependency = structuredClone(manifest);
        unknownDependency.assets[0].dependencies.push('unknown');
        expect(() => validateDistributionManifest(unknownDependency)).toThrow(/distribution-dependency-unknown/);
        const unknownPresetAsset = structuredClone(manifest);
        unknownPresetAsset.presets[0].requiredAssets.push('unknown');
        expect(() => validateDistributionManifest(unknownPresetAsset)).toThrow(/distribution-preset-asset-unknown/);
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
          expect(loaded.manifest.sourceRevision).toBe(sourceRevision);
          await expect(loadDistributionManifest({
              manifestUrl: 'https://github.com/a3-suite/a3-ci-github/releases/download/v9.9.9/a3-ci-github-distribution-manifest.json',
            })).rejects.toThrow(/distribution-manifest-release-url-mismatch/);
          await expect(loadDistributionManifest({ manifestUrl: 'https://example.invalid/manifest.json' })).rejects.toThrow(/distribution-manifest-url-untrusted/);
          await expect(loadDistributionManifest({ manifestPath: release.manifestPath, manifestUrl: validUrl })).rejects.toThrow(/distribution-manifest-source-exclusive/);
        } finally {
          globalThis.fetch = originalFetch;
        }
      });
    });
  });
});

describe("contract.ci-selective-distribution.selection", () => {
  describe("selective-distribution", () => {
    // contract_id: contract.ci-selective-distribution.selection
    test('preset selection closes dependencies while direct asset selection reports missing dependencies', async () => {
      await withFixture('a3-ci-github-distribution-selection-', (root) => {
        const { manifest } = prepareRelease(root);
        const presetAssets = resolveDistributionSelection(manifest, ['quality-gate'], []);
        expect(presetAssets.some((asset) => asset.id === 'registry.ci-github')).toBeTruthy();
        expect(presetAssets.some((asset) => asset.id === 'workflow.quality-gate')).toBeTruthy();
        expect(() => resolveDistributionSelection(manifest, [], [])).toThrow(/distribution-selection-required/);
        expect(() => resolveDistributionSelection(manifest, ['unknown'], [])).toThrow(/distribution-preset-unknown/);
        expect(() => resolveDistributionSelection(manifest, [], ['unknown'])).toThrow(/distribution-asset-unknown/);
        expect(() => resolveDistributionSelection(manifest, [], ['runtime.preset'])).toThrow(/distribution-dependency-missing:runtime\.preset:registry\.ci-github/);
        const cyclic = structuredClone(manifest);
        cyclic.assets.find((asset) => asset.id === 'registry.ci-github').dependencies.push('runtime.preset');
        expect(() => resolveDistributionSelection(cyclic, ['quality-gate'], [])).toThrow(/distribution-dependency-cycle/);
        const directAssets = resolveDistributionSelection(
          manifest,
          [],
          ['runtime.preset', 'registry.ci-github'],
        );
        expect(directAssets.map((asset) => asset.id)).toStrictEqual(['registry.ci-github', 'runtime.preset']);
      });
    });
  });
});

describe("contract.ci-selective-distribution.application", () => {
  describe("selective-distribution", () => {
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
          expect(fetched.action).toBe('fetched');
          expect(fs.existsSync(path.join(fetched.distributionRoot, 'runtime/preset/run-validate-ci-preset.mjs'))).toBeTruthy();
          expect(verifyFetchedDistribution({ projectRoot, sourceRevision }).status).toBe('verified');
          const plan = planDistributionApplication({
            projectRoot,
            sourceRevision,
            requestedPresets: ['quality-gate'],
            requestedAssets: [],
          });
          expect(plan.actions.map((entry) => entry.action)).toStrictEqual(['create']);
          const applied = applyDistributionPlan({
            projectRoot,
            planPath: plan.planPath,
            approvalDigest: plan.planDigest,
          });
          const workflow = path.join(projectRoot, '.github/workflows/quality-gate.yml');
          expect(applied.status).toBe('applied');
          expect(fs.existsSync(workflow)).toBeTruthy();
          expect(applied.nextSteps.includes('preflight')).toBeTruthy();
          expect(applied.nextSteps.includes('materialize-adapters')).toBe(false);
          const ordinaryFiles = (directory) => fs.readdirSync(directory, { withFileTypes: true })
            .filter((entry) => directory !== projectRoot || entry.name !== '.a3-skills')
            .flatMap((entry) => entry.isDirectory()
              ? ordinaryFiles(path.join(directory, entry.name))
              : [path.relative(projectRoot, path.join(directory, entry.name)).split(path.sep).join('/')]);
          expect(ordinaryFiles(projectRoot).sort()).toStrictEqual(['.github/workflows/quality-gate.yml', 'README.md']);
          expect(fs.readFileSync(existingFile, 'utf8')).toBe('consumer-owned documentation\n');
          expect(fs.readFileSync(workflow, 'utf8')).not.toMatch(/\.a3-skills\//);
          const rolledBack = rollbackDistributionTransaction({ projectRoot, transactionId: applied.transactionId });
          expect(rolledBack.status).toBe('rolled-back');
          expect(rolledBack.rollbackStatus).toBe('restored');
          expect(fs.existsSync(workflow)).toBe(false);
          expect(fs.readFileSync(existingFile, 'utf8')).toBe('consumer-owned documentation\n');
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
          expect(ordinaryFiles(projectRoot).sort()).toStrictEqual([
            '.ci/platform-manifest.yml', '.ci/quality-platforms.yml',
            '.github/workflows/quality-gate-platforms.yml', '.github/workflows/quality-gate.yml', 'README.md',
          ]);
          const optionalWorkflow = fs.readFileSync(path.join(projectRoot, '.github/workflows/quality-gate-platforms.yml'), 'utf8');
          expect(optionalWorkflow).toMatch(/uses: a3-suite\/a3-ci-github\/\.github\/workflows\/ci-quality-platforms.yml@<quality-platforms-workflow-sha>/);
          expect(optionalWorkflow).not.toMatch(/ci-platform-matrix@|id: trusted-assets/);
          expect(optionalWorkflow).not.toMatch(/CoreLoader|pyyaml|\.a3-skills\//);
          for (const [relative, text] of Object.entries(configurations)) {
            expect(fs.readFileSync(path.join(projectRoot, relative), 'utf8')).toBe(text);
          }
          expect(fs.readFileSync(existingFile, 'utf8')).toBe('consumer-owned documentation\n');
          expect(rollbackDistributionTransaction({ projectRoot, transactionId: optionalApplied.transactionId }).status).toBe('rolled-back');
          expect(ordinaryFiles(projectRoot).sort()).toStrictEqual(['.ci/platform-manifest.yml', '.ci/quality-platforms.yml', 'README.md']);
          const releaseSelection = { requestedPresets: ['release-request', 'release-publication'], requestedAssets: [] };
          await fetchDistribution({ projectRoot, manifest: release.manifest, manifestBytes: release.manifestBytes,
            sourceRoot: repositoryRoot, ...releaseSelection });
          const releasePlan = planDistributionApplication({ projectRoot, sourceRevision, ...releaseSelection });
          const releaseApplied = applyDistributionPlan({ projectRoot, planPath: releasePlan.planPath, approvalDigest: releasePlan.planDigest });
          expect(ordinaryFiles(projectRoot).sort()).toStrictEqual([
            '.ci/platform-manifest.yml', '.ci/quality-platforms.yml',
            '.github/workflows/release-publication-caller.yml', '.github/workflows/release-publication-request.yml',
            '.github/workflows/release-request-tag.yml', 'README.md',
          ]);
          expect(fs.existsSync(path.join(projectRoot, '.github/workflows/release-publication.yml'))).toBe(false);
          const publication = fs.readFileSync(path.join(projectRoot, '.github/workflows/release-publication-caller.yml'), 'utf8');
          expect(publication).toMatch(/ci-release-publication\.yml@<release-publication-workflow-sha>/);
          expect(publication).not.toMatch(/\.a3-skills\//);
          expect(fs.readFileSync(existingFile, 'utf8')).toBe('consumer-owned documentation\n');
          expect(rollbackDistributionTransaction({ projectRoot, transactionId: releaseApplied.transactionId }).status).toBe('rolled-back');
          expect(ordinaryFiles(projectRoot).sort()).toStrictEqual(['.ci/platform-manifest.yml', '.ci/quality-platforms.yml', 'README.md']);
          const packageSelection = { requestedPresets: ['package-publication'], requestedAssets: [] };
          await fetchDistribution({ projectRoot, manifest: release.manifest, manifestBytes: release.manifestBytes,
            sourceRoot: repositoryRoot, ...packageSelection });
          const packagePlan = planDistributionApplication({ projectRoot, sourceRevision, ...packageSelection });
          const packageApplied = applyDistributionPlan({ projectRoot, planPath: packagePlan.planPath, approvalDigest: packagePlan.planDigest });
          expect(ordinaryFiles(projectRoot).sort()).toStrictEqual([
            '.ci/platform-manifest.yml', '.ci/quality-platforms.yml',
            '.github/workflows/package-publication-caller.yml', '.github/workflows/package-publication-request.yml', 'README.md',
          ]);
          expect(fs.existsSync(path.join(projectRoot, '.github/workflows/package-publication.yml'))).toBe(false);
          expect(fs.existsSync(path.join(projectRoot, '.github/workflows/package-preparation.yml'))).toBe(false);
          const packageCaller = fs.readFileSync(path.join(projectRoot, '.github/workflows/package-publication-caller.yml'), 'utf8');
          expect(packageCaller).toMatch(/ci-package-publication\.yml@<package-publication-workflow-sha>/);
          expect(fs.readFileSync(existingFile, 'utf8')).toBe('consumer-owned documentation\n');
          expect(rollbackDistributionTransaction({ projectRoot, transactionId: packageApplied.transactionId }).status).toBe('rolled-back');
          expect(ordinaryFiles(projectRoot).sort()).toStrictEqual(['.ci/platform-manifest.yml', '.ci/quality-platforms.yml', 'README.md']);

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
          expect(conflict.actions.map((entry) => entry.action)).toStrictEqual(['conflict']);
          expect(() => applyDistributionPlan({ projectRoot, planPath: conflict.planPath, approvalDigest: conflict.planDigest })).toThrow(/distribution-plan-has-conflicts/);
          fs.rmSync(workflow);
          const plan = planDistributionApplication({
            projectRoot,
            sourceRevision,
            requestedPresets: ['quality-gate'],
            requestedAssets: [],
          });
          fs.writeFileSync(workflow, 'name: changed-after-plan\n');
          expect(() => applyDistributionPlan({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest })).toThrow(/distribution-plan-input-changed/);
      });
    });
  });
});

describe("contract.ci-selective-distribution.delivery", () => {
  describe("selective-distribution", () => {
    // contract_id: contract.ci-selective-distribution.delivery
    test('fetch rejects source bytes that do not match the release manifest', async () => {
      await withFixture('a3-ci-github-distribution-integrity-', async (root) => {
        const release = prepareRelease(root);
        const projectRoot = path.join(root, 'consumer');
        fs.mkdirSync(projectRoot);
        const manifest = structuredClone(release.manifest);
        manifest.files['workflows/quality/quality-gate.yml'].sha256 = '0'.repeat(64);
        const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
        await expect(fetchDistribution({
            projectRoot,
            manifest,
            manifestBytes,
            requestedPresets: [],
            requestedAssets: ['workflow.quality-gate', 'runtime.quality-workflow', 'runtime.preset', 'registry.ci-github'],
            sourceRoot: repositoryRoot,
          })).rejects.toThrow(/distribution-file-integrity-mismatch/);
        expect(fs.existsSync(path.join(projectRoot, '.a3-skills/ci-github/distributions', sourceRevision))).toBe(false);
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
        await expect(fetchDistribution({
            projectRoot,
            manifest: release.manifest,
            manifestBytes: release.manifestBytes,
            requestedPresets: ['quality-gate'],
            requestedAssets: [],
            sourceRoot: repositoryRoot,
          })).rejects.toThrow(/distribution-local-root-outside-project/);
        expect(fs.readdirSync(externalRoot)).toStrictEqual([]);
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
        expect(() => verifyFetchedDistribution({ projectRoot, sourceRevision })).toThrow(/distribution-local-file-integrity-mismatch/);
      });
    });
  });
});

describe("contract.ci-selective-distribution.application", () => {
  describe("selective-distribution", () => {
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
        expect(() => planDistributionApplication({
            projectRoot,
            sourceRevision,
            requestedPresets: [],
            requestedAssets: ['workflow.quality-gate', 'runtime.quality-workflow', 'runtime.preset', 'registry.ci-github'],
          })).toThrow(/distribution-copy-requires-matching-preset:workflow\.quality-gate/);
        await fetchDistribution({
          projectRoot,
          manifest: release.manifest,
          manifestBytes: release.manifestBytes,
          requestedPresets: ['release-request'],
          requestedAssets: [],
          sourceRoot: repositoryRoot,
        });
        expect(() => planDistributionApplication({
            projectRoot,
            sourceRevision,
            requestedPresets: ['release-request'],
            requestedAssets: ['workflow.quality-gate', 'runtime.quality-workflow', 'runtime.preset', 'registry.ci-github'],
          })).toThrow(/distribution-copy-requires-matching-preset:workflow\.quality-gate/);
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
        expect(optionalPlan.actions.some((entry) => entry.assetId === 'workflow.quality-gate-platforms')).toBeTruthy();
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
        expect(() => applyDistributionPlan({
            projectRoot,
            planPath: plan.planPath,
            approvalDigest: plan.planDigest,
            beforeWrite: () => fs.symlinkSync(externalRoot, path.join(projectRoot, '.github')),
          })).toThrow(/distribution-destination-outside-root/);
        expect(fs.readdirSync(externalRoot)).toStrictEqual([]);
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
        expect(plan.actions.length > 1).toBeTruthy();
        const changedLater = plan.actions[1].destination;
        const changedPath = path.join(projectRoot, changedLater);
        expect(() => applyDistributionPlan({
            projectRoot,
            planPath: plan.planPath,
            approvalDigest: plan.planDigest,
            beforeWrite: ({ index }) => {
              if (index !== 1) return;
              fs.mkdirSync(path.dirname(changedPath), { recursive: true });
              fs.writeFileSync(changedPath, 'changed-after-plan\n');
            },
          })).toThrow(/distribution-plan-input-changed/);
        expect(fs.existsSync(path.join(projectRoot, plan.actions[0].destination))).toBe(false);
        expect(fs.readFileSync(changedPath, 'utf8')).toBe('changed-after-plan\n');
        const transactionsRoot = path.join(projectRoot, '.a3-skills/ci-github/transactions');
        const transactionDirectories = fs.readdirSync(transactionsRoot);
        expect(transactionDirectories.length).toBe(1);
        const transaction = JSON.parse(fs.readFileSync(
          path.join(transactionsRoot, transactionDirectories[0], 'transaction.json'),
          'utf8',
        ));
        expect(transaction.status).toBe('rolled-back');
        expect(transaction.actions[0].state).toBe('restored');
        expect(transaction.actions[1].state).toBe('not-applied');
        transaction.status = 'rollback-required';
        const transactionPath = path.join(transactionsRoot, transactionDirectories[0], 'transaction.json');
        fs.writeFileSync(transactionPath, `${JSON.stringify(transaction, null, 2)}\n`);
        expect(rollbackDistributionTransaction({
          projectRoot,
          transactionId: transaction.transactionId,
        }).status).toBe('rolled-back');
        expect(fs.readFileSync(changedPath, 'utf8')).toBe('changed-after-plan\n');
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
        expect(() => planDistributionApplication({
            projectRoot,
            sourceRevision,
            requestedPresets: ['quality-gate'],
            requestedAssets: [],
          })).toThrow(/distribution-prior-asset-lock-invalid/);
        fs.rmSync(assetLockPath);
        const plan = planDistributionApplication({
          projectRoot,
          sourceRevision,
          requestedPresets: ['quality-gate'],
          requestedAssets: [],
        });
        expect(() => applyDistributionPlan({ projectRoot, planPath: plan.planPath, approvalDigest: '0'.repeat(64) })).toThrow(/distribution-plan-approval-invalid/);
        fs.mkdirSync(path.dirname(assetLockPath), { recursive: true });
        fs.writeFileSync(assetLockPath, '{}\n');
        expect(() => applyDistributionPlan({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest })).toThrow(/distribution-plan-ownership-changed/);
        fs.rmSync(assetLockPath);
        const mutationLock = path.join(projectRoot, '.a3-skills/ci-github/apply.lock');
        const transactionsPath = path.join(projectRoot, '.a3-skills/ci-github/transactions');
        const externalTransactions = path.join(root, 'external-transactions');
        fs.rmSync(transactionsPath, { recursive: true, force: true });
        fs.mkdirSync(externalTransactions);
        fs.symlinkSync(externalTransactions, transactionsPath);
        expect(() => applyDistributionPlan({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest })).toThrow(/distribution-transaction-root-outside-project/);
        expect(fs.existsSync(mutationLock)).toBe(false);
        fs.rmSync(transactionsPath);
        fs.writeFileSync(mutationLock, 'occupied\n');
        expect(() => applyDistributionPlan({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest })).toThrow(/distribution-apply-locked/);
        fs.rmSync(mutationLock);
        const applied = applyDistributionPlan({
          projectRoot,
          planPath: plan.planPath,
          approvalDigest: plan.planDigest,
        });
        fs.writeFileSync(mutationLock, 'occupied\n');
        expect(() => rollbackDistributionTransaction({ projectRoot, transactionId: applied.transactionId })).toThrow(/distribution-apply-locked/);
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
        expect(() => rollbackDistributionTransaction({ projectRoot, transactionId })).toThrow(/distribution-backup-integrity-mismatch/);
        expect(fs.readFileSync(path.join(projectRoot, first.destination), 'utf8')).toBe(first.after);
        fs.writeFileSync(path.join(transactionRoot, 'before', second.destination), second.before);
        const transactionPath = path.join(transactionRoot, 'transaction.json');
        const interrupted = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
        interrupted.status = 'applying';
        interrupted.actions[0].state = 'restored';
        fs.writeFileSync(path.join(projectRoot, first.destination), first.before);
        fs.writeFileSync(transactionPath, `${JSON.stringify(interrupted, null, 2)}\n`);
        expect(rollbackDistributionTransaction({ projectRoot, transactionId }).status).toBe('rolled-back');
        expect(fs.readFileSync(path.join(projectRoot, second.destination), 'utf8')).toBe(second.before);
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
        expect(() => rollbackDistributionTransaction({ projectRoot, transactionId: applied.transactionId })).toThrow(/distribution-rollback-destination-changed/);
        expect(fs.readFileSync(workflow, 'utf8')).toBe('name: edited-after-apply\n');
      });
      for (const scenario of ['consumer-edit', 'destination-symlink', 'backup-tamper']) {
        await withFixture(`distribution-rollback-${scenario}-`, (root) => {
          const projectRoot = path.join(root, 'consumer');
          const transactionId = `1-${'a'.repeat(12)}`;
          const transactionRoot = path.join(projectRoot, '.a3-skills/ci-github/transactions', transactionId);
          const destination = '.github/workflows/quality-gate.yml';
          const workflow = path.join(projectRoot, destination);
          const backup = path.join(transactionRoot, 'before', destination);
          const transactionPath = path.join(transactionRoot, 'transaction.json');
          const externalRoot = path.join(root, 'external-workflows');
          fs.mkdirSync(path.dirname(workflow), { recursive: true });
          fs.mkdirSync(path.dirname(backup), { recursive: true });
          fs.mkdirSync(externalRoot);
          fs.writeFileSync(workflow, 'applied\n');
          fs.writeFileSync(backup, 'before\n');
          fs.writeFileSync(path.join(externalRoot, 'quality-gate.yml'), 'applied\n');
          fs.writeFileSync(transactionPath, JSON.stringify({
            schemaVersion: '1', kind: 'a3-ci-github-distribution-transaction', transactionId,
            status: 'applied', actions: [{ destination, beforeSha256: sha256('before\n'),
              afterSha256: sha256('applied\n'), state: 'applied' }],
          }));
          const renameSync = fs.renameSync;
          let changed = false;
          const rename = vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
            renameSync(source, target);
            if (target !== transactionPath || changed
              || JSON.parse(fs.readFileSync(transactionPath, 'utf8')).status !== 'rolling-back') return;
            changed = true;
            if (scenario === 'consumer-edit') fs.writeFileSync(workflow, 'consumer edit\n');
            else if (scenario === 'backup-tamper') fs.writeFileSync(backup, 'tampered backup\n');
            else {
              fs.unlinkSync(workflow);
              fs.rmdirSync(path.dirname(workflow));
              fs.symlinkSync(externalRoot, path.dirname(workflow));
            }
          });
          try {
            const diagnostic = scenario === 'consumer-edit' ? /distribution-rollback-destination-changed/
              : scenario === 'backup-tamper' ? /distribution-backup-integrity-mismatch/
                : /distribution-destination-outside-root/;
            expect(() => rollbackDistributionTransaction({ projectRoot, transactionId })).toThrow(diagnostic);
            expect(changed).toBe(true);
            expect(fs.readFileSync(workflow, 'utf8')).toBe(scenario === 'consumer-edit' ? 'consumer edit\n' : 'applied\n');
            expect(fs.readFileSync(path.join(externalRoot, 'quality-gate.yml'), 'utf8')).toBe('applied\n');
            expect(JSON.parse(fs.readFileSync(transactionPath, 'utf8')).status).toBe('rollback-required');
          } finally {
            rename.mockRestore();
          }
        });
      }
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
        expect(fetchResult.status, fetchResult.stderr).toBe(0);
        const fetched = JSON.parse(fetchResult.stdout);
        expect(fetched.sourceRevision).toBe(sourceRevision);
        const verifyResult = spawnSync(process.execPath, [
          cli, 'verify',
          '--source-revision', sourceRevision,
          '--repo-root', projectRoot,
        ], { encoding: 'utf8' });
        expect(verifyResult.status, verifyResult.stderr).toBe(0);
        expect(JSON.parse(verifyResult.stdout).status).toBe('verified');
        const planResult = spawnSync(process.execPath, [
          cli, 'plan',
          '--source-revision', sourceRevision,
          '--preset', 'quality-gate',
          '--repo-root', projectRoot,
        ], { encoding: 'utf8' });
        expect(planResult.status, planResult.stderr).toBe(0);
        const plan = JSON.parse(planResult.stdout);
        const applyResult = spawnSync(process.execPath, [
          cli, 'apply',
          '--plan', plan.planPath,
          '--approve', plan.planDigest,
          '--repo-root', projectRoot,
        ], { encoding: 'utf8' });
        expect(applyResult.status, applyResult.stderr).toBe(0);
        const applied = JSON.parse(applyResult.stdout);
        expect(applied.status).toBe('applied');
        const requireFromPreset = createRequire(path.join(repositoryRoot, 'runtime/preset/package.json'));
        const { parse } = requireFromPreset('yaml');
        const command = parse(fs.readFileSync(path.join(repositoryRoot, 'sdd/dsl/specs/cli/commands/manage-ci-distribution/cli-command.sdd.yml'), 'utf8')).command;
        const vocabulary = parse(fs.readFileSync(path.join(repositoryRoot, 'sdd/dsl/specs/cli/cli-option-vocabulary.sdd.yml'), 'utf8'));
        const flags = new Map(vocabulary.options.map((option) => [option.id, option.long]));
        const publicOptions = command.option_groups.flatMap((group) => group.options);
        const beforeRejection = snapshotTree(projectRoot);
        for (const target of command.usage_targets) {
          const allowed = new Set(target.option_bindings.map((binding) => binding.option_id));
          const required = target.option_bindings
            .filter((binding) => binding.presence === 'required')
            .flatMap((binding) => [flags.get(binding.option_id), 'unused']);
          for (const option of publicOptions.filter((id) => !allowed.has(id))) {
            const flag = flags.get(option);
            const rejected = spawnSync(process.execPath, [
              cli, target.id, '--repo-root', projectRoot, ...required, flag, 'unused',
            ], { encoding: 'utf8' });
            expect(rejected.status, `${target.id} ${flag}: ${rejected.stderr}`).toBe(2);
            expect(rejected.stdout).toBe('');
            expect(JSON.parse(rejected.stderr).diagnostic).toBe(`distribution-cli-argument-invalid:${flag}`);
            expect(snapshotTree(projectRoot)).toStrictEqual(beforeRejection);
          }
        }
        const rollbackResult = spawnSync(process.execPath, [
          cli, 'rollback', '--repo-root', projectRoot, '--transaction', applied.transactionId,
        ], { encoding: 'utf8' });
        expect(rollbackResult.status, rollbackResult.stderr).toBe(0);
        expect(JSON.parse(rollbackResult.stdout).status).toBe('rolled-back');
      });
    });
  });
});

describe("contract.ci-selective-distribution.delivery", () => {
  describe("selective-distribution", () => {
    // contract_id: contract.ci-selective-distribution.delivery
    test('standalone public CLI executes through an absolute symlinked path', async () => {
      await withFixture('a3-ci-github-distribution-cli-symlink-', (root) => {
        const cli = path.join(repositoryRoot, 'runtime/distribution/fetch-a3-ci-github.mjs');
        const link = path.join(root, 'fetch-a3-ci-github.mjs');
        fs.symlinkSync(cli, link);
        const result = spawnSync(process.execPath, [link, 'unknown-command'], { encoding: 'utf8' });
        expect(result.status, result.stderr).toBe(2);
        expect(result.stderr).toMatch(/distribution-command-unknown/);
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
          expect(merged.action).toBe('merged');
          expect(merged.selectedAssets).toStrictEqual(['lint.github-actions', 'registry.ci-github']);
          expect(fs.existsSync(path.join(merged.distributionRoot, 'skills/ci-github/references/ci-distribution-assets.reference.yml'))).toBeTruthy();
          expect(fs.existsSync(path.join(merged.distributionRoot, 'lint-rules/a3-lint/ci_github_workflow_name_matches_file.lua'))).toBeTruthy();
      });
    });
  });
});

describe("contract.ci-selective-distribution.delivery", () => {
  describe("selective-distribution-delivery", () => {
    // evidence_role: contract
    // test_level: integration
    // contract_id: contract.ci-selective-distribution.delivery
    // integration_id: selective-distribution-delivery
    test('remote fetch reuses verified files for repeat and extended preset selections', async () => {
      // Arrange
      await withFixture('distribution-remote-reuse-', async (root) => {
        const release = prepareRelease(root);
        const projectRoot = path.join(root, 'consumer');
        fs.mkdirSync(projectRoot);
        const requestedPaths = (preset) => [...new Set(resolveDistributionSelection(release.manifest, [preset], [])
          .flatMap((asset) => asset.files.map((file) => file.sourcePath)))].sort();
        const requestPaths = requestedPaths('release-request');
        const qualityPaths = requestedPaths('quality-gate');
        const calls = [];
        const fetch = (preset) => fetchDistribution({
          projectRoot, manifest: release.manifest, manifestBytes: release.manifestBytes,
          requestedPresets: [preset], requestedAssets: [],
          download: async (url) => {
            const relative = url.split(`/${sourceRevision}/`)[1];
            calls.push(relative);
            return fs.readFileSync(path.join(committedSourceRoot, relative));
          },
        });

        // Act / Assert
        const first = await fetch('release-request');
        expect(calls.sort()).toEqual(requestPaths);
        expect(first.action).toBe('fetched');
        const receiptBeforeRepeat = fs.readFileSync(path.join(first.distributionRoot, 'receipt.json'));
        calls.length = 0;
        const repeated = await fetch('release-request');
        expect(calls).toEqual([]);
        expect(repeated.action).toBe('merged');
        expect(fs.readFileSync(path.join(first.distributionRoot, 'receipt.json'))).toEqual(receiptBeforeRepeat);
        calls.length = 0;
        const extended = await fetch('quality-gate');
        expect(calls.sort()).toEqual(qualityPaths.filter((relative) => !requestPaths.includes(relative)));
        expect(extended.selectedPresets).toEqual(['quality-gate', 'release-request']);
        expect(verifyFetchedDistribution({ projectRoot, sourceRevision }).status).toBe('verified');
        expect(fs.existsSync(path.join(first.distributionRoot, '.fetch.lock'))).toBe(false);
      });
    });

    // evidence_role: contract
    // test_level: integration
    // contract_id: contract.ci-selective-distribution.delivery
    // integration_id: selective-distribution-delivery
    test('remote fetch rejects invalid cached state and concurrent fetch locks before transport', async () => {
      // Arrange
      await withFixture('distribution-remote-cache-rejection-', async (root) => {
        const release = prepareRelease(root);
        for (const problem of ['bytes', 'receipt', 'manifest', 'lock']) {
          const projectRoot = path.join(root, problem);
          fs.mkdirSync(projectRoot);
          const options = { projectRoot, manifest: release.manifest, manifestBytes: release.manifestBytes,
            requestedPresets: ['release-request'], requestedAssets: [] };
          const fetched = await fetchDistribution({ ...options, sourceRoot: committedSourceRoot });
          let diagnostic;
          if (problem === 'bytes') {
            fs.appendFileSync(path.join(fetched.distributionRoot, fetched.files[0]), 'tampered');
            diagnostic = /distribution-local-file-integrity-mismatch/;
          } else if (problem === 'receipt') {
            const receiptPath = path.join(fetched.distributionRoot, 'receipt.json');
            const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
            receipt.manifestSha256 = '0'.repeat(64);
            fs.writeFileSync(receiptPath, JSON.stringify(receipt));
            diagnostic = /distribution-local-receipt-invalid/;
          } else if (problem === 'manifest') {
            options.manifestBytes = Buffer.concat([release.manifestBytes, Buffer.from('\n')]);
            diagnostic = /distribution-existing-root-conflict/;
          } else {
            fs.writeFileSync(path.join(fetched.distributionRoot, '.fetch.lock'), 'another fetch owns this lock');
            diagnostic = /distribution-fetch-locked/;
          }
          const before = snapshotTree(projectRoot);
          const download = vi.fn(async () => { throw new Error('transport must not be called'); });

          // Act / Assert
          await expect(fetchDistribution({ ...options, download })).rejects.toThrow(diagnostic);
          expect(download).not.toHaveBeenCalled();
          expect(snapshotTree(projectRoot)).toEqual(before);
        }
      });
    });

    // evidence_role: contract
    // test_level: integration
    // contract_id: contract.ci-selective-distribution.delivery
    // integration_id: selective-distribution-delivery
    test('remote fetch preserves prior state and releases its lock after an extension fails', async () => {
      // Arrange
      await withFixture('distribution-remote-extension-failure-', async (root) => {
        const release = prepareRelease(root);
        const projectRoot = path.join(root, 'consumer');
        fs.mkdirSync(projectRoot);
        const fetched = await fetchDistribution({ projectRoot, manifest: release.manifest,
          manifestBytes: release.manifestBytes, requestedPresets: ['release-request'], requestedAssets: [],
          sourceRoot: committedSourceRoot });
        const before = snapshotTree(projectRoot);
        let calls = 0;
        const peerDownload = vi.fn(async () => { throw new Error('peer transport must not be called'); });
        const options = { projectRoot, manifest: release.manifest, manifestBytes: release.manifestBytes,
          requestedPresets: ['quality-gate'], requestedAssets: [] };

        // Act / Assert
        await expect(fetchDistribution({ ...options, download: async (url) => {
          calls += 1;
          expect(fs.existsSync(path.join(fetched.distributionRoot, '.fetch.lock'))).toBe(true);
          if (calls === 1) {
            await expect(fetchDistribution({ ...options, download: peerDownload })).rejects.toThrow('distribution-fetch-locked');
          } else {
            throw new Error('extension transport failed');
          }
          return fs.readFileSync(path.join(committedSourceRoot, url.split(`/${sourceRevision}/`)[1]));
        } })).rejects.toThrow('extension transport failed');
        expect(calls).toBe(2);
        expect(peerDownload).not.toHaveBeenCalled();
        expect(snapshotTree(projectRoot)).toEqual(before);
        expect(verifyFetchedDistribution({ projectRoot, sourceRevision }).status).toBe('verified');
        const recovered = await fetchDistribution({ ...options, download: async (url) =>
          fs.readFileSync(path.join(committedSourceRoot, url.split(`/${sourceRevision}/`)[1])) });
        expect(recovered.action).toBe('merged');
        expect(verifyFetchedDistribution({ projectRoot, sourceRevision }).status).toBe('verified');
        expect(fs.existsSync(path.join(fetched.distributionRoot, '.fetch.lock'))).toBe(false);
      });
    });

    // evidence_role: contract
    // test_level: integration
    // contract_id: contract.ci-selective-distribution.delivery
    // integration_id: selective-distribution-delivery
    test('fetch removes staging even when closing or removing its owned lock fails', async () => {
      // Arrange
      await withFixture('distribution-lock-cleanup-failure-', async (root) => {
        const release = prepareRelease(root);
        for (const operation of ['close', 'remove']) {
          const projectRoot = path.join(root, operation);
          fs.mkdirSync(projectRoot);
          const options = { projectRoot, manifest: release.manifest, manifestBytes: release.manifestBytes,
            requestedPresets: ['release-request'], requestedAssets: [] };
          const fetched = await fetchDistribution({ ...options, sourceRoot: committedSourceRoot });
          const lockPath = path.join(fetched.distributionRoot, '.fetch.lock');
          const stateRoot = path.join(projectRoot, '.a3-skills/ci-github');
          const originalOpen = fs.openSync;
          const originalClose = fs.closeSync;
          const originalRemove = fs.rmSync;
          const download = vi.fn();
          let lockHandle;
          const opened = vi.spyOn(fs, 'openSync').mockImplementation((target, ...openOptions) => {
            const handle = originalOpen(target, ...openOptions);
            if (target === lockPath) lockHandle = handle;
            return handle;
          });
          const cleanup = operation === 'close'
            ? vi.spyOn(fs, 'closeSync').mockImplementation((handle) => {
              originalClose(handle);
              if (handle === lockHandle) throw new Error('lock close failed');
            })
            : vi.spyOn(fs, 'rmSync').mockImplementation((target, removeOptions) => {
              if (target === lockPath) throw new Error('lock removal failed');
              return originalRemove(target, removeOptions);
            });
          try {
            // Act / Assert
            await expect(fetchDistribution({ ...options, download })).rejects.toThrow(
              operation === 'close' ? 'lock close failed' : 'lock removal failed');
            expect(download).not.toHaveBeenCalled();
            expect(fs.readdirSync(stateRoot).filter((name) => name.startsWith('.staging-'))).toEqual([]);
          } finally {
            cleanup.mockRestore();
            opened.mockRestore();
          }
        }
      });
    });

    // evidence_role: contract
    // test_level: integration
    // contract_id: contract.ci-selective-distribution.delivery
    // integration_id: selective-distribution-delivery
    test('explicit source root remains validated when a verified distribution already exists', async () => {
      // Arrange
      await withFixture('distribution-repeat-source-validation-', async (root) => {
        const release = prepareRelease(root);
        const projectRoot = path.join(root, 'consumer');
        fs.mkdirSync(projectRoot);
        const options = { projectRoot, manifest: release.manifest, manifestBytes: release.manifestBytes,
          requestedPresets: ['release-request'], requestedAssets: [] };
        await fetchDistribution({ ...options, sourceRoot: committedSourceRoot });
        const sourceRoot = path.join(root, 'invalid-source');
        const firstFile = resolveDistributionSelection(release.manifest, ['release-request'], [])[0].files[0].sourcePath;
        const invalidFile = path.join(sourceRoot, firstFile);
        fs.mkdirSync(path.dirname(invalidFile), { recursive: true });
        fs.writeFileSync(invalidFile, 'invalid explicit source bytes');
        const before = snapshotTree(projectRoot);
        const download = vi.fn();

        // Act / Assert
        await expect(fetchDistribution({ ...options, sourceRoot, download })).rejects.toThrow('distribution-file-integrity-mismatch');
        expect(download).not.toHaveBeenCalled();
        expect(snapshotTree(projectRoot)).toEqual(before);
      });
    });
  });
});

describe("contract.ci-selective-distribution.delivery", () => {
  describe("selective-distribution", () => {
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
          expect(result.status, result.stderr).toBe(0);
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
        expect(fs.existsSync(materializer)).toBe(false);
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
        expect(merged.action).toBe('merged');
        expect(fs.existsSync(materializer)).toBeTruthy();
        expect(verifyFetchedDistribution({ projectRoot, sourceRevision }).status).toBe(before.status);
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
        expect(fs.readdirSync(adapterProject)).toStrictEqual(beforeFiles);
      });
    });
  });
});

describe("contract.ci-selective-distribution.delivery", () => {
  describe("selective-distribution-delivery", () => {
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
            await expect(fetchDistribution({
              projectRoot, manifest: release.manifest, manifestBytes: release.manifestBytes,
              requestedPresets: ['quality-gate'], requestedAssets: [],
            }), label).rejects.toThrow(diagnostic);
            expect(requests.length > 0, label).toBeTruthy();
            expect(requests.every((url) => url.startsWith(`${release.manifest.rawOrigin}/${release.manifest.repository}/${sourceRevision}/`)), label).toBeTruthy();
            expect(snapshotTree(projectRoot), label).toStrictEqual(before);
          }
        } finally {
          globalThis.fetch = originalFetch;
        }
      });
    });
  });
});

describe("contract.ci-selective-distribution.application", () => {
  describe("selective-distribution-application", () => {
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
          expect(() => planDistributionApplication({ projectRoot, sourceRevision,
            requestedPresets: ['quality-gate'], requestedAssets: [] }), label).toThrow(/distribution-prior-asset-lock-invalid/);
          expect(snapshotTree(projectRoot), label).toStrictEqual(before);
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
        expect(reuse.actions.map((entry) => entry.action)).toStrictEqual(['reuse']);
        expect(writes).toBe(0);
        expect(fs.readFileSync(workflow)).toStrictEqual(canonical);
        const reusedTransaction = path.join(projectRoot, '.a3-skills/ci-github/transactions', reused.transactionId);
        expect(JSON.parse(fs.readFileSync(path.join(reusedTransaction, 'transaction.json'), 'utf8')).actions).toStrictEqual([]);
        rollbackDistributionTransaction({ projectRoot, transactionId: reused.transactionId });
        expect(fs.readFileSync(workflow)).toStrictEqual(canonical);
        // Arrange
        const oldManagedBytes = Buffer.from('name: previously managed workflow\n');
        fs.writeFileSync(workflow, oldManagedBytes);
        writeOwnership(oldManagedBytes);
        const ownershipBefore = fs.readFileSync(lockPath);
        const update = planDistributionApplication(options);
        // Act
        const updated = applyDistributionPlan({ projectRoot, planPath: update.planPath, approvalDigest: update.planDigest });
        // Assert
        expect(update.actions.map((entry) => entry.action)).toStrictEqual(['update']);
        expect(fs.readFileSync(workflow)).toStrictEqual(canonical);
        const transactionRoot = path.join(projectRoot, '.a3-skills/ci-github/transactions', updated.transactionId);
        expect(fs.readFileSync(path.join(transactionRoot, 'before', workflowPath))).toStrictEqual(oldManagedBytes);
        expect(fs.readFileSync(lockPath)).toStrictEqual(ownershipBefore);
        // Act
        const rolledBack = rollbackDistributionTransaction({ projectRoot, transactionId: updated.transactionId });
        // Assert
        expect(rolledBack.rollbackStatus).toBe('restored');
        expect(fs.readFileSync(workflow)).toStrictEqual(oldManagedBytes);
        expect(fs.readFileSync(lockPath)).toStrictEqual(ownershipBefore);
        expect(fs.readFileSync(projectDocument, 'utf8')).toBe('project-owned content');
        // Arrange
        fs.writeFileSync(workflow, 'unmanaged project edit');
        const conflict = planDistributionApplication(options);
        const before = snapshotTree(projectRoot);
        // Act / Assert
        expect(conflict.actions.map((entry) => entry.action)).toStrictEqual(['conflict']);
        expect(() => applyDistributionPlan({ projectRoot, planPath: conflict.planPath,
          approvalDigest: conflict.planDigest })).toThrow(/distribution-plan-has-conflicts/);
        expect(snapshotTree(projectRoot)).toStrictEqual(before);
      });
    });
  });
});
