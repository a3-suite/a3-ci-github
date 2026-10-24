import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, test, describe } from 'vitest';
import { pathToFileURL } from 'node:url';
import { applyDistributionPlan, fetchDistribution, resolveDistributionSelection, rollbackDistributionTransaction, validateDistributionManifest, verifyFetchedDistribution } from '../fetch-a3-ci-github.mjs';
import { snapshotTree } from '../../preset/tests/support/release-request-fixture.mjs';
import { repositoryRoot, tsx, fixtureSettings, planDistributionApplication, releaseTag, committedSourceRoot, sourceRevision, sha256, withFixture, generateRelease, baseline, prepareRelease } from "./selective-distribution.fixtures.mjs";

describe("contract.ci-selective-distribution.delivery", () => {
  describe("selective-distribution", () => {
    // contract_id: contract.ci-selective-distribution.delivery
    test('release generator derives deterministic selective assets and checksums from registries', async () => {
      await withFixture('a3-ci-github-distribution-release-', (root) => {
        const first = generateRelease(root);
        for (const filename of fs.readdirSync(first.output, { recursive: true })) {
          if (fs.statSync(path.join(first.output, filename)).isDirectory()) continue;
          expect(fs.readFileSync(path.join(first.output, filename))).toEqual(fs.readFileSync(path.join(baseline.output, filename)));
        }
        const manifest = validateDistributionManifest(first.manifest);
        expect(manifest.sourceRevision).toBe(sourceRevision);
        for (const binding of Object.values(manifest.reusableWorkflows)) {
          expect(binding.sourceRevision).toBe(sourceRevision);
          expect(binding).not.toHaveProperty('acceptance');
        }
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
        expect(fs.readdirSync(first.output).sort()).toStrictEqual([
          'SHA256SUMS',
          'a3-ci-github-distribution-manifest.json',
          'a3-ci-github-skills.zip',
          'a3-ci-github-skills.zip.sha256',
          'fetch-a3-ci-github.mjs',
          'skills-evidence',
        ]);
        const skillsZip = fs.readFileSync(path.join(first.output, 'a3-ci-github-skills.zip'));
        expect(fs.readFileSync(path.join(first.output, 'a3-ci-github-skills.zip.sha256'), 'utf8'))
          .toBe(`${sha256(skillsZip)}  a3-ci-github-skills.zip\n`);
        const owner = JSON.parse(fs.readFileSync(path.join(first.output, 'skills-evidence/a3-ci-github-skills.zip.owner.json'), 'utf8'));
        expect(owner).toMatchObject({ owner_contract: 'ci.release-skills-package', source_sha: sourceRevision, asset_sha256: sha256(skillsZip) });
        for (const entry of ['ci-github/SKILL.md', 'ci-release-installer/SKILL.md']) expect(skillsZip.includes(entry), entry).toBe(true);
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
        assert.equal(registry[${JSON.stringify(binding)}].status, 'available');
        assert.equal(registry[${JSON.stringify(binding)}].exactRef, ${JSON.stringify(sourceRevision)});
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
          const release = generateRelease(root);
          expect(release.manifest.files[sourcePath].sha256).toBe(sha256(committedBytes));
          expect(release.manifest.files[sourcePath].sha256).not.toBe(sha256(Buffer.from('working-tree-only-change\n')));
        } finally {
          fs.writeFileSync(workingPath, committedBytes);
        }
      });
    });

    // contract_id: contract.ci-selective-distribution.delivery
    test('release generator retains exit code when diagnostic sinks fail', () => {
      // Arrange
      const generator = path.join(repositoryRoot, 'runtime/distribution/generate-distribution-release.ts');
      const loader = createRequire(path.join(repositoryRoot, 'runtime/preset/package.json')).resolve('tsx');
      const driver = `process.argv=[process.execPath,${JSON.stringify(generator)}];process.stderr.write=()=>{throw new Error('private-sink-failure')};process.on('uncaughtException',()=>{process.exitCode=88});await import(${JSON.stringify(generator)});`;
      // Act
      const result = spawnSync(process.execPath, ['--import', loader, '--input-type=module', '-e', driver], { encoding: 'utf8' });
      // Assert
      expect(result.status).toBe(2);
      expect(result.stdout + result.stderr).toBe('');
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
        // Arrange
        const linkedSource = path.join(root, 'linked-source');
        const clone = spawnSync('git', ['clone', '--quiet', '--no-hardlinks', committedSourceRoot, linkedSource], { encoding: 'utf8', timeout: 5000 });
        expect(clone.status, clone.stderr).toBe(0);
        const linkedAsset = 'lint-rules/a3-lint/linked.lua';
        fs.symlinkSync('ci_github_workflow_external_action_full_sha.lua', path.join(linkedSource, linkedAsset));
        const fixtureGit = (args) => {
          const result = spawnSync('git', args, { cwd: linkedSource, encoding: 'utf8', timeout: 5000 });
          expect(result.status, result.stderr).toBe(0);
          return result.stdout.trim();
        };
        fixtureGit(['add', linkedAsset]);
        fixtureGit(['-c', 'user.name=Distribution Test', '-c', 'user.email=distribution-test@example.invalid', 'commit', '-qm', 'symlink fixture']);
        const linkedRevision = fixtureGit(['rev-parse', 'HEAD']);
        const linkedOutput = path.join(root, 'linked-output');
        // Act
        const linkedResult = spawnSync(tsx, [generator,
          '--repository-root', linkedSource, '--source-revision', linkedRevision,
          '--release-tag', releaseTag, '--output-directory', linkedOutput,
        ], { encoding: 'utf8' });
        // Assert
        expect(linkedResult.status).toBe(2);
        expect(linkedResult.stderr).toContain('distribution-source-symlink');
        expect(fs.existsSync(linkedOutput)).toBe(false);
      });
    });
  });
});


describe("contract.ci-selective-distribution.selection", () => {
  describe("selective-distribution", () => {

    // contract_id: contract.ci-selective-distribution.selection
    test('selection rejection retains the rejected request and missing dependency as failure details', async () => {
      await withFixture('a3-ci-github-distribution-selection-diagnostic-', (root) => {
        const release = prepareRelease(root);
        const projectRoot = path.join(root, 'consumer');
        fs.mkdirSync(projectRoot);
        const cli = path.join(repositoryRoot, 'runtime/distribution/fetch-a3-ci-github.mjs');
        const cases = [
          [['--preset', 'private-preset-value'], 'distribution-preset-unknown', { field: 'preset', expected: 'registered-preset', observed: 'unregistered' }],
          [['--asset', 'runtime.preset'], 'distribution-dependency-missing', { field: 'runtime.preset.dependencies', expected: 'registry.ci-github', observed: 'not-selected' }],
          [['--asset', 'private-asset-value'], 'distribution-asset-unknown', { field: 'asset', expected: 'registered-asset', observed: 'unregistered' }],
        ];
        for (const [selection, reason, comparison] of cases) {
          const result = spawnSync(process.execPath, [
            cli, 'fetch', '--manifest', release.manifestPath, '--source-root', repositoryRoot, ...selection, '--repo-root', projectRoot,
          ], { encoding: 'utf8' });
          expect(result.status, result.stderr).toBe(2);
          const evidence = JSON.parse(result.stderr).failureEvidence;
          expect(evidence.classification).toMatchObject({ subject: 'ci-selective-distribution', operation: 'fetch', stage: 'selection', reason });
          expect(evidence.comparison).toStrictEqual(comparison);
          expect(evidence['execution-state'].write).toBe('not-started');
          expect(fs.readdirSync(projectRoot)).toEqual([]);
          expect(result.stdout + result.stderr).not.toMatch(/private-(?:preset|asset)-value/);
        }
      });
    });
  });
});


describe("contract.ci-selective-distribution.application", () => {
  describe('provider-pin-companion', () => {
    // contract_id: contract.ci-selective-distribution.application
    // contract_id: contract.ci-preset-assurance.asset-lock
    test('Release and Package generated companions support lock and preflight without fixture pin injection', async () => {
      await withFixture('distribution-generated-preflight-', async (root) => {
        const release = prepareRelease(root);
        for (const preset of ['release-publication', 'package-publication']) {
          const projectRoot = path.join(root, preset);
          fs.mkdirSync(path.join(projectRoot, '.ci/scripts'), { recursive: true });
          fs.mkdirSync(path.join(projectRoot, '.ci/trusted'), { recursive: true });
          fs.writeFileSync(path.join(projectRoot, 'Cargo.toml'), '[package]\nname = "fixture"\nversion = "1.2.3"\n');
          fs.writeFileSync(path.join(projectRoot, 'Cargo.lock'), 'version = 4\n');
          fs.writeFileSync(path.join(projectRoot, '.ci/platform-manifest.yml'), 'platforms: [{id: linux-x64, runner: ubuntu-24.04, target: x86_64-unknown-linux-gnu}]\n');
          for (const name of ['.ci/scripts/ci-package-build.sh', '.ci/trusted/ci-package-publish.sh']) fs.writeFileSync(path.join(projectRoot, name), '#!/bin/bash\nexit 0\n');
          const selection = { requestedPresets: [preset], requestedAssets: [] };
          const fetched = await fetchDistribution({ projectRoot, manifest: release.manifest, manifestBytes: release.manifestBytes,
            sourceRoot: repositoryRoot, ...selection });
          const plan = planDistributionApplication({ projectRoot, sourceRevision, ...selection,
            settingOverrides: { 'language-profile': 'rust', 'standard-bundle-id': 'rust-cargo-quality',
              'release-implementation': 'rust-cli-release', 'toolchain-version': '1.90.0', 'cargo-audit-version': '0.21.0',
              'cargo-manifest-path': 'Cargo.toml', 'cargo-lock-path': 'Cargo.lock', 'release-binary-name': 'fixture', 'release-asset-prefix': 'fixture',
              'supplemental-release-asset-owner-contract': '__unset__', 'supplemental-release-asset-config-path': '__unset__' } });
          applyDistributionPlan({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest });
          const scriptPath = path.join(root, `${preset}.mts`);
          const moduleUrl = (relative) => JSON.stringify(pathToFileURL(path.join(fetched.distributionRoot, relative)).href);
          fs.writeFileSync(scriptPath, `import assert from 'node:assert/strict';
import { writeCiAssetLock } from ${moduleUrl('runtime/preset/ci-asset-lock-plan.ts')};
import { validateCiPreset } from ${moduleUrl('runtime/preset/validate-ci-preset.ts')};
const lock = writeCiAssetLock({ repoRoot: ${JSON.stringify(projectRoot)}, sourceRevision: ${JSON.stringify(sourceRevision)}, releaseTag: ${JSON.stringify(releaseTag)} });
assert.ok(lock.assets.some(entry => entry.path === '.ci/provider-action-pins.yml'));
const report = validateCiPreset({ repoRoot: ${JSON.stringify(projectRoot)} });
assert.equal(report.status, 'success', JSON.stringify(report));`);
          const result = spawnSync(tsx, [scriptPath], { encoding: 'utf8', env: { ...process.env,
            CI_GITHUB_PREFLIGHT_RUNTIME_ROOT: path.join(repositoryRoot, 'runtime/preset'), CI_FIXED_RUNTIME_ROOT: path.join(repositoryRoot, 'runtime/preset') } });
          expect(result.status, result.stderr).toBe(0);
        }
      });
    });
    // contract_id: contract.ci-selective-distribution.application
    test('explicit create migration restores retired assets and the prior lock after a post-apply failure', async () => {
      await withFixture('distribution-create-migration-', async (root) => {
        const release = prepareRelease(root);
        const projectRoot = path.join(root, 'consumer');
        const previous = new Map([
          ['.ci/ci-assets.lock.json', JSON.stringify({ schemaVersion: '1', kind: 'ci-github-asset-lock', sourceRevision: 'b'.repeat(40), assets: [] })],
          ['.github/workflows/release-publication-request.yml', 'old caller\n'],
          ['.ci/scripts/ci-source-gate.sh', 'old retired entrypoint\n'],
        ]);
        const backupRoot = path.join(projectRoot, 'tmp/migration');
        for (const [relative, bytes] of previous) {
          const current = path.join(projectRoot, relative);
          const backup = path.join(backupRoot, relative);
          fs.mkdirSync(path.dirname(current), { recursive: true });
          fs.mkdirSync(path.dirname(backup), { recursive: true });
          fs.writeFileSync(current, bytes);
          fs.copyFileSync(current, backup);
          expect(sha256(fs.readFileSync(backup))).toBe(sha256(Buffer.from(bytes)));
          fs.unlinkSync(current);
        }
        fs.writeFileSync(path.join(projectRoot, 'README.md'), 'unrelated owner content\n');
        const selection = { requestedPresets: ['release-request'], requestedAssets: [] };
        const fetched = await fetchDistribution({ projectRoot, manifest: release.manifest, manifestBytes: release.manifestBytes,
          sourceRoot: repositoryRoot, ...selection });
        const plan = planDistributionApplication({ projectRoot, sourceRevision, ...selection });
        expect(plan.actions.every(entry => entry.action === 'create')).toBe(true);
        expect(() => applyDistributionPlan({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest,
          beforeWrite: ({ index }) => { if (index === 1) throw new Error('migration-apply-failed'); } }))
          .toThrow(/distribution-unknown-failure/);
        const transactionsRoot = path.join(projectRoot, '.a3-skills/ci-github/transactions');
        const transaction = JSON.parse(fs.readFileSync(path.join(transactionsRoot, fs.readdirSync(transactionsRoot)[0], 'transaction.json')));
        expect(transaction.status).toBe('rolled-back');
        for (const entry of plan.actions) expect(fs.existsSync(path.join(projectRoot, entry.destination))).toBe(false);
        expect(() => rollbackDistributionTransaction({ projectRoot, transactionId: transaction.transactionId }))
          .toThrow(/distribution-transaction-not-rollbackable/);
        for (const [relative, bytes] of previous) {
          fs.copyFileSync(path.join(backupRoot, relative), path.join(projectRoot, relative));
          expect(fs.readFileSync(path.join(projectRoot, relative), 'utf8')).toBe(bytes);
          fs.unlinkSync(path.join(projectRoot, relative));
        }
        const applied = applyDistributionPlan({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest });
        const mismatchedPath = path.join(root, 'generate-mismatched-lock.mts');
        fs.writeFileSync(mismatchedPath, `import { writeCiAssetLock } from ${JSON.stringify(pathToFileURL(path.join(fetched.distributionRoot, 'runtime/preset/ci-asset-lock-plan.ts')).href)};\nwriteCiAssetLock({ repoRoot: ${JSON.stringify(projectRoot)}, sourceRevision: ${JSON.stringify(sourceRevision)}, releaseTag: 'v99.0.0' });`);
        const mismatched = spawnSync(tsx, [mismatchedPath], { encoding: 'utf8', env: { ...process.env,
          CI_GITHUB_PREFLIGHT_RUNTIME_ROOT: path.join(repositoryRoot, 'runtime/preset'), CI_FIXED_RUNTIME_ROOT: path.join(repositoryRoot, 'runtime/preset') } });
        expect(mismatched.status).not.toBe(0);
        expect(mismatched.stderr).toContain('asset lock source must match the fetched distribution Release');
        expect(fs.existsSync(path.join(projectRoot, '.ci/ci-assets.lock.json'))).toBe(false);
        const scriptPath = path.join(root, 'generate-lock.mts');
        fs.writeFileSync(scriptPath, `import { writeCiAssetLock } from ${JSON.stringify(pathToFileURL(path.join(fetched.distributionRoot, 'runtime/preset/ci-asset-lock-plan.ts')).href)};\nwriteCiAssetLock({ repoRoot: ${JSON.stringify(projectRoot)}, sourceRevision: ${JSON.stringify(sourceRevision)}, releaseTag: ${JSON.stringify(releaseTag)} });`);
        const generated = spawnSync(tsx, [scriptPath], { encoding: 'utf8', env: { ...process.env,
          CI_GITHUB_PREFLIGHT_RUNTIME_ROOT: path.join(repositoryRoot, 'runtime/preset'), CI_FIXED_RUNTIME_ROOT: path.join(repositoryRoot, 'runtime/preset') } });
        expect(generated.status, generated.stderr).toBe(0);
        const lockPath = path.join(projectRoot, '.ci/ci-assets.lock.json');
        const newLockSha256 = sha256(fs.readFileSync(lockPath));
        rollbackDistributionTransaction({ projectRoot, transactionId: applied.transactionId });
        expect(sha256(fs.readFileSync(lockPath))).toBe(newLockSha256);
        fs.unlinkSync(lockPath);
        for (const [relative, bytes] of previous) {
          const backup = path.join(backupRoot, relative);
          expect(sha256(fs.readFileSync(backup))).toBe(sha256(Buffer.from(bytes)));
          expect(fs.existsSync(path.join(projectRoot, relative))).toBe(false);
          fs.copyFileSync(backup, path.join(projectRoot, relative));
          expect(fs.readFileSync(path.join(projectRoot, relative), 'utf8')).toBe(bytes);
        }
        expect(fs.existsSync(path.join(projectRoot, '.ci/provider-action-pins.yml'))).toBe(false);
        expect(fs.readFileSync(path.join(projectRoot, 'README.md'), 'utf8')).toBe('unrelated owner content\n');
        expect(fs.existsSync(fetched.distributionRoot)).toBe(true);
      });
    });
  });
});



describe("contract.ci-selective-distribution.application", () => {
  describe("selective-distribution", () => {

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
        const yamlSource = path.dirname(createRequire(path.join(repositoryRoot, 'runtime/preset/package.json')).resolve('yaml/package.json'));
        const yamlDestination = path.join(projectRoot, '.a3-skills/ci-github/runtime/node_modules/yaml');
        fs.mkdirSync(path.dirname(yamlDestination), { recursive: true });
        fs.cpSync(yamlSource, yamlDestination, { recursive: true });
        const unsetPlan = spawnSync(process.execPath, [
          cli, 'plan', '--source-revision', sourceRevision, '--preset', 'quality-gate', '--repo-root', projectRoot,
        ], { encoding: 'utf8' });
        expect(unsetPlan.status).toBe(2);
        const unsetEvidence = JSON.parse(unsetPlan.stderr);
        expect(unsetEvidence.diagnostic).toBe('workflow-template-setting-missing');
        expect(unsetEvidence.failureEvidence.classification).toMatchObject({ operation: 'plan', stage: 'template-render', reason: 'workflow-template-setting-missing', cause: 'known' });
        const planResult = spawnSync(process.execPath, [
          cli, 'plan',
          '--source-revision', sourceRevision,
          '--preset', 'quality-gate',
          '--repo-root', projectRoot,
          ...Object.entries(fixtureSettings).filter(([key]) =>
            fs.readFileSync(path.join(repositoryRoot, 'workflows/quality/quality-gate.yml'), 'utf8').includes(`<${key}>`))
            .flatMap(([key, value]) => ['--set', `workflow.quality-gate:${key}=${JSON.stringify(value)}`]),
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
        const commands = ['fetch', 'verify', 'plan', 'apply', 'rollback'].map((operation) => parse(fs.readFileSync(path.join(repositoryRoot, `sdd/dsl/specs/cli/commands/manage-ci-distribution-${operation}/cli-command.sdd.yml`), 'utf8')).command);
        const vocabulary = parse(fs.readFileSync(path.join(repositoryRoot, 'sdd/dsl/specs/cli/cli-option-vocabulary.sdd.yml'), 'utf8'));
        const flags = new Map(vocabulary.options.map((option) => [option.id, option.long]));
        // The operations share one parser, so every option published by any operation must be rejected where it is not bound.
        const publicOptions = [...new Set(commands.flatMap((command) => command.option_groups.flatMap((group) => group.options)))];
        const beforeRejection = snapshotTree(projectRoot);
        for (const target of commands.flatMap((command) => command.usage_targets)) {
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
        const requestPlan = planDistributionApplication({ projectRoot, sourceRevision, requestedPresets: ['release-request'], requestedAssets: [] });
        applyDistributionPlan({ projectRoot, planPath: requestPlan.planPath, approvalDigest: requestPlan.planDigest });
        const moduleUrl = (distributionRoot, relative) => JSON.stringify(pathToFileURL(path.join(distributionRoot, relative)).href);
        run(`import assert from 'node:assert/strict';
      import { writeCiAssetLock } from ${moduleUrl(request.distributionRoot, 'runtime/preset/ci-asset-lock-plan.ts')};
      import { validateCiPreset } from ${moduleUrl(request.distributionRoot, 'runtime/preset/validate-ci-preset.ts')};
      const lock = writeCiAssetLock({ repoRoot: ${JSON.stringify(projectRoot)}, sourceRevision: ${JSON.stringify(sourceRevision)}, releaseTag: ${JSON.stringify(releaseTag)} });
      assert.equal(lock.assets.length, 2);
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
      const result = materializeAdapterBundle({ sourceRoot: ${JSON.stringify(adapterProject)}, inventoryPath: 'skills/ci-github/assets/registry/ci-script-assets.yml', bundleId: 'typescript-npm-quality', targetRoot: ${JSON.stringify(adapterProject)} });
      assert.deepEqual(result.files, []);
      assert.equal(result.binding.standardBundleId, 'typescript-npm-quality');`);
        expect(fs.readdirSync(adapterProject)).toStrictEqual(beforeFiles);
      });
    });
  });
});
