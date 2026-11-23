import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, test, describe } from 'vitest';
import { pathToFileURL } from 'node:url';
import { applyDistributionPlan, fetchDistribution, resolveDistributionSelection, rollbackDistributionTransaction, validateDistributionManifest, verifyFetchedDistribution } from '../fetch-a3-ci-github.mjs';
import { snapshotTree } from '../../preset/tests/support/release-request-fixture.mjs';
import { cliFetch, cliRollback, cliVerify, repositoryRoot, tsx, fixtureSettings, planDistributionApplication, releaseTag, committedSourceRoot, sourceRevision, sha256, withFixture, runReleaseGenerator, generateRelease, baseline, prepareRelease } from "./selective-distribution.fixtures.mjs";

describe('contract.ci-selective-distribution.verification', () => {
  // contract_id: contract.ci-selective-distribution.verification
  test('verify rejects missing or malformed cache metadata without changing the consumer tree', async () => {
    await withFixture('distribution-verify-metadata-', (root) => {
      const release = prepareRelease(root);
      const projectRoot = path.join(root, 'consumer');
      fs.mkdirSync(projectRoot);
      const verify = () => cliVerify({ projectRoot, sourceRevision });
      const empty = snapshotTree(projectRoot);
      expect(verify).toThrow(/^distribution-local-manifest-missing$/);
      expect(snapshotTree(projectRoot)).toStrictEqual(empty);

      const fetched = cliFetch({ projectRoot, manifestPath: release.manifestPath,
        requestedPresets: ['release-request'], sourceRoot: committedSourceRoot });
      for (const name of ['manifest', 'receipt']) {
        const metadataPath = path.join(fetched.distributionRoot, `${name}.json`);
        const original = fs.readFileSync(metadataPath);
        fs.writeFileSync(metadataPath, '{');
        const malformed = snapshotTree(projectRoot);
        expect(verify).toThrow(new RegExp(`^distribution-local-${name}-invalid$`));
        expect(snapshotTree(projectRoot)).toStrictEqual(malformed);
        fs.writeFileSync(metadataPath, original);
      }
    });
  });

  // contract_id: contract.ci-selective-distribution.verification
  test('verify reports verified for a merged distribution', async () => {
    await withFixture('distribution-verify-merged-', (root) => {
      const release = prepareRelease(root);
      const projectRoot = path.join(root, 'consumer');
      fs.mkdirSync(projectRoot);
      const options = { projectRoot, manifestPath: release.manifestPath, sourceRoot: committedSourceRoot };
      cliFetch({ ...options, requestedPresets: ['release-request'] });
      cliFetch({ ...options, requestedPresets: ['quality-gate'] });
      cliFetch({ ...options, requestedPresets: ['quality-gate'], requestedAssets: ['runtime.adapter-materializer'] });

      expect(cliVerify({ projectRoot, sourceRevision }).status).toBe('verified');
    });
  });

  // contract_id: contract.ci-selective-distribution.verification
  test('verify reports input validation for missing malformed and unbound arguments', () => {
    const cli = path.join(repositoryRoot, 'runtime/distribution/fetch-a3-ci-github.mjs');
    for (const args of [[], ['--source-revision', 'invalid'], ['--manifest', 'unused']]) {
      const result = spawnSync(process.execPath, [cli, 'verify', ...args], { encoding: 'utf8' });
      expect(result.status, args.join(' ')).toBe(2);
      expect(JSON.parse(result.stderr).failureEvidence.classification).toMatchObject({
        operation: 'verify', stage: 'input-validation',
      });
    }
  });
});

describe("contract.ci-selective-distribution.delivery", () => {
  describe("selective-distribution", () => {
    // contract_id: contract.ci-selective-distribution.release-generation
    test('release generator records the source revision and binds every manifest file digest and size to its source file', async () => {
      await withFixture('a3-ci-github-distribution-release-source-', (root) => {
        const manifest = validateDistributionManifest(generateRelease(root).manifest);
        expect(manifest.sourceRevision).toBe(sourceRevision);
        for (const [relative, entry] of Object.entries(manifest.files)) {
          const bytes = fs.readFileSync(path.join(committedSourceRoot, relative));
          expect(entry.sha256, relative).toBe(sha256(bytes));
          expect(entry.size, relative).toBe(bytes.length);
        }
      });
    });

    // evidence_role: supplemental
    // The deterministic bytes, the selected asset sets, the checksum file and the skills package of a generated release are the content of the release, not observations of a generation guarantee.
    // contract_id: contract.ci-selective-distribution.release-generation
    test('release generator derives deterministic selective assets and checksums from registries', async () => {
      await withFixture('a3-ci-github-distribution-release-', (root) => {
        const first = generateRelease(root);
        for (const filename of fs.readdirSync(first.output, { recursive: true })) {
          if (fs.statSync(path.join(first.output, filename)).isDirectory()) continue;
          expect(fs.readFileSync(path.join(first.output, filename))).toEqual(fs.readFileSync(path.join(baseline.output, filename)));
        }
        const manifest = validateDistributionManifest(first.manifest);
        for (const binding of Object.values(manifest.reusableWorkflows)) {
          expect(binding.sourceRevision).toBe(sourceRevision);
          expect(binding).not.toHaveProperty('acceptance');
        }
        expect(manifest.assets.some((asset) => asset.id === 'runtime.preset')).toBeTruthy();
        expect(manifest.assets.some((asset) => asset.id === 'workflow.quality-gate')).toBeTruthy();
        expect(manifest.files['skills/ci-github/references/ci-script-contracts.reference.yml']).toBeTruthy();
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
    // evidence_role: supplemental
    // Resolving the reusable workflow callee from fetched sources is a runtime preflight mechanism, not an observation of a delivery guarantee.
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

    // contract_id: contract.ci-selective-distribution.release-generation
    test('release generator hashes committed bytes when the working tree differs', async () => {
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

    // evidence_role: supplemental
    // Breaks the diagnostic sink, so the failure stage cannot be observed.
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

    // contract_id: contract.ci-selective-distribution.release-generation
    test('release generator reports the argument validation stage when the output option is missing', () => {
      const result = runReleaseGenerator([]);
      expect(result.status).toBe(2);
      const prefix = 'ci-failure-diagnostic:';
      const evidence = result.stderr.split('\n').find((line) => line.startsWith(prefix));
      expect(JSON.parse(evidence.slice(prefix.length)).classification).toMatchObject({
        operation: 'generate', stage: 'input-validation', reason: 'distribution-release-output-required',
      });
    });

    // contract_id: contract.ci-selective-distribution.release-generation
    test('release generator rejects invalid version source and output boundaries', async () => {
      await withFixture('a3-ci-github-distribution-release-guards-', (root) => {
        const execute = (args) => runReleaseGenerator(['--repository-root', committedSourceRoot, ...args]);
        const invalidSha = execute([
          '--output-directory', path.join(root, 'invalid-sha'),
          '--source-revision', 'main',
          '--release-tag', releaseTag,
        ]);
        expect(invalidSha.status).toBe(2);
        expect(invalidSha.stderr).toMatch(/distribution-release-source-revision-invalid/);
        expect(fs.existsSync(path.join(root, 'invalid-sha'))).toBe(false);
        const invalidTag = execute([
          '--output-directory', path.join(root, 'invalid-tag'),
          '--source-revision', sourceRevision,
          '--release-tag', 'latest',
        ]);
        expect(invalidTag.status).toBe(2);
        expect(invalidTag.stderr).toMatch(/distribution-release-tag-invalid/);
        expect(fs.existsSync(path.join(root, 'invalid-tag'))).toBe(false);
        const versionMismatch = execute([
          '--output-directory', path.join(root, 'version-mismatch'),
          '--source-revision', sourceRevision,
          '--release-tag', 'v9.9.9',
        ]);
        expect(versionMismatch.status).toBe(2);
        expect(versionMismatch.stderr).toMatch(/distribution-release-version-mismatch/);
        expect(versionMismatch.stderr).toMatch(/^ci-failure-diagnostic:.*"classification":\{[^}]*"stage":"distribution-generation"/m);
        expect(fs.existsSync(path.join(root, 'version-mismatch'))).toBe(false);
        const headMismatch = execute([
          '--output-directory', path.join(root, 'head-mismatch'),
          '--source-revision', 'e'.repeat(40),
          '--release-tag', releaseTag,
        ]);
        expect(headMismatch.status).toBe(2);
        expect(headMismatch.stderr).toMatch(/distribution-release-source-head-mismatch/);
        expect(fs.existsSync(path.join(root, 'head-mismatch'))).toBe(false);
        const existingOutput = path.join(root, 'existing');
        fs.mkdirSync(existingOutput);
        const existingBefore = snapshotTree(existingOutput);
        const outputConflict = execute([
          '--output-directory', existingOutput,
          '--source-revision', sourceRevision,
          '--release-tag', releaseTag,
        ]);
        expect(outputConflict.status).toBe(2);
        expect(outputConflict.stderr).toMatch(/distribution-release-output-exists/);
        expect(snapshotTree(existingOutput)).toEqual(existingBefore);
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
        const linkedResult = runReleaseGenerator([
          '--repository-root', linkedSource, '--source-revision', linkedRevision,
          '--release-tag', releaseTag, '--output-directory', linkedOutput,
        ]);
        // Assert
        expect(linkedResult.status).toBe(2);
        expect(linkedResult.stderr).toContain('distribution-source-symlink');
        expect(fs.existsSync(linkedOutput)).toBe(false);

        fs.unlinkSync(path.join(linkedSource, linkedAsset));
        const registryPath = 'skills/ci-github/assets/registry/ci-distribution-assets.yml';
        const registryFile = path.join(linkedSource, registryPath);
        const registry = fs.readFileSync(registryFile, 'utf8');
        const sourcePath = 'skills/ci-github/assets/registry/ci-github-preset-assets.yml';
        for (const [kind, invalidPath] of [['absolute', '/invalid.yml'], ['parent-relative', '../invalid.yml']]) {
          fs.writeFileSync(registryFile, registry.replace(sourcePath, invalidPath));
          fixtureGit(['add', '-u']);
          fixtureGit(['-c', 'user.name=Distribution Test', '-c', 'user.email=distribution-test@example.invalid', 'commit', '-qm', `invalid ${kind} source path fixture`]);
          const output = path.join(root, `invalid-${kind}-source`);
          const result = runReleaseGenerator([
            '--repository-root', linkedSource, '--source-revision', fixtureGit(['rev-parse', 'HEAD']),
            '--release-tag', releaseTag, '--output-directory', output,
          ]);
          expect(result.status, result.stderr).toBe(2);
          expect(result.stderr).toContain('distribution-path-invalid');
          expect(fs.existsSync(output)).toBe(false);
        }
        fs.writeFileSync(registryFile, registry);
        fs.unlinkSync(path.join(linkedSource, '.ci/release-skills.json'));
        fixtureGit(['add', '-u']);
        fixtureGit(['-c', 'user.name=Distribution Test', '-c', 'user.email=distribution-test@example.invalid', 'commit', '-qm', 'missing skill declaration fixture']);
        const missingDeclarationOutput = path.join(root, 'missing-declaration-output');
        const missingDeclaration = runReleaseGenerator([
          '--repository-root', linkedSource, '--source-revision', fixtureGit(['rev-parse', 'HEAD']),
          '--release-tag', releaseTag, '--output-directory', missingDeclarationOutput,
        ]);
        expect(missingDeclaration.status).toBe(2);
        expect(missingDeclaration.stderr).toContain('skills-declaration-invalid');
        expect(fs.existsSync(missingDeclarationOutput)).toBe(false);

        fixtureGit(['rm', 'VERSION']);
        fixtureGit(['-c', 'user.name=Distribution Test', '-c', 'user.email=distribution-test@example.invalid', 'commit', '-qm', 'missing version fixture']);
        const missingVersionOutput = path.join(root, 'missing-version-output');
        const missingVersion = runReleaseGenerator([
          '--repository-root', linkedSource, '--source-revision', fixtureGit(['rev-parse', 'HEAD']),
          '--release-tag', releaseTag, '--output-directory', missingVersionOutput,
        ]);
        expect(missingVersion.status).toBe(2);
        const diagnostic = missingVersion.stderr.match(/^ci-failure-diagnostic:(.+)$/m);
        expect(JSON.parse(diagnostic?.[1] ?? '{}').classification).toMatchObject({
          stage: 'distribution-generation', reason: 'distribution-release-git-read-failed',
        });
        expect(missingVersion.stderr).not.toContain('fatal:');
        expect(fs.existsSync(missingVersionOutput)).toBe(false);
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
    // evidence_role: supplemental
    // The asset lock and the preflight consume the applied companions; they are not observations of a plan or apply guarantee.
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
        let secondRollback;
        try { cliRollback({ projectRoot, transactionId: transaction.transactionId }); } catch (error) { secondRollback = error; }
        expect(secondRollback.message).toBe('distribution-transaction-not-rollbackable');
        expect(secondRollback.evidence.classification.stage).toEqual(expect.any(String));
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
      });
    });
    // evidence_role: supplemental
    // The fetched distribution root outliving a rollback is a side effect of the transaction, not an observation of a lock generation guarantee.
    // contract_id: contract.ci-selective-distribution.application
    test('rolling back an applied distribution keeps the fetched distribution root', async () => {
      await withFixture('distribution-rollback-fetched-root-', async (root) => {
        // Arrange
        const release = prepareRelease(root);
        const projectRoot = path.join(root, 'consumer');
        fs.mkdirSync(projectRoot, { recursive: true });
        const selection = { requestedPresets: ['release-request'], requestedAssets: [] };
        const fetched = await fetchDistribution({ projectRoot, manifest: release.manifest, manifestBytes: release.manifestBytes,
          sourceRoot: repositoryRoot, ...selection });
        const plan = planDistributionApplication({ projectRoot, sourceRevision, ...selection });
        const applied = applyDistributionPlan({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest });
        // Act
        rollbackDistributionTransaction({ projectRoot, transactionId: applied.transactionId });
        // Assert
        expect(fs.existsSync(fetched.distributionRoot)).toBe(true);
      });
    });
    // evidence_role: supplemental
    // Writing no lock is a side effect of the rejected generation, not an observation of the lock rejection diagnostic.
    test('asset lock generation rejected for a mismatched distribution Release writes no lock', async () => {
      await withFixture('distribution-lock-mismatch-', async (root) => {
        // Arrange
        const release = prepareRelease(root);
        const projectRoot = path.join(root, 'consumer');
        fs.mkdirSync(projectRoot, { recursive: true });
        const selection = { requestedPresets: ['release-request'], requestedAssets: [] };
        const fetched = await fetchDistribution({ projectRoot, manifest: release.manifest, manifestBytes: release.manifestBytes,
          sourceRoot: repositoryRoot, ...selection });
        const plan = planDistributionApplication({ projectRoot, sourceRevision, ...selection });
        applyDistributionPlan({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest });
        const mismatchedPath = path.join(root, 'generate-mismatched-lock.mts');
        fs.writeFileSync(mismatchedPath, `import { writeCiAssetLock } from ${JSON.stringify(pathToFileURL(path.join(fetched.distributionRoot, 'runtime/preset/ci-asset-lock-plan.ts')).href)};\nwriteCiAssetLock({ repoRoot: ${JSON.stringify(projectRoot)}, sourceRevision: ${JSON.stringify(sourceRevision)}, releaseTag: 'v99.0.0' });`);

        // Act
        const mismatched = spawnSync(tsx, [mismatchedPath], { encoding: 'utf8', env: { ...process.env,
          CI_GITHUB_PREFLIGHT_RUNTIME_ROOT: path.join(repositoryRoot, 'runtime/preset'), CI_FIXED_RUNTIME_ROOT: path.join(repositoryRoot, 'runtime/preset') } });

        // Assert
        expect(mismatched.status).not.toBe(0);
        expect(fs.existsSync(path.join(projectRoot, '.ci/ci-assets.lock.json'))).toBe(false);
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
        // The operations share one parser, so every option published by any operation must be rejected where it is not bound.
        const unboundOptions = [
          { operation: 'fetch', required: [], rejected: ['--source-revision', '--set', '--plan', '--approve', '--transaction'] },
          { operation: 'verify', required: ['--source-revision'], rejected: ['--manifest', '--manifest-url', '--preset', '--asset', '--source-root', '--set', '--plan', '--approve', '--transaction'] },
          { operation: 'plan', required: ['--source-revision'], rejected: ['--manifest', '--manifest-url', '--source-root', '--plan', '--approve', '--transaction'] },
          { operation: 'apply', required: ['--plan', '--approve'], rejected: ['--manifest', '--manifest-url', '--preset', '--asset', '--source-root', '--source-revision', '--set', '--transaction'] },
          { operation: 'rollback', required: ['--transaction'], rejected: ['--manifest', '--manifest-url', '--preset', '--asset', '--source-root', '--source-revision', '--set', '--plan', '--approve'] },
        ];
        const beforeRejection = snapshotTree(projectRoot);
        for (const { operation, required, rejected: rejectedFlags } of unboundOptions) {
          for (const flag of rejectedFlags) {
            const rejected = spawnSync(process.execPath, [
              cli, operation, '--repo-root', projectRoot, ...required.flatMap((option) => [option, 'unused']), flag, 'unused',
            ], { encoding: 'utf8' });
            expect(rejected.status, `${operation} ${flag}: ${rejected.stderr}`).toBe(2);
            expect(rejected.stdout).toBe('');
            expect(JSON.parse(rejected.stderr).diagnostic).toBe(`distribution-cli-argument-invalid:${flag}`);
            expect(JSON.parse(rejected.stderr).failureEvidence.classification.stage, `${operation} ${flag}`).toEqual(expect.any(String));
            // The tree preservation of a rejected rollback has no guarantee; the supplemental test below observes it.
            if (operation !== 'rollback') expect(snapshotTree(projectRoot)).toStrictEqual(beforeRejection);
          }
        }
        const rollbackResult = spawnSync(process.execPath, [
          cli, 'rollback', '--repo-root', projectRoot, '--transaction', applied.transactionId,
        ], { encoding: 'utf8' });
        expect(rollbackResult.status, rollbackResult.stderr).toBe(0);
        expect(JSON.parse(rollbackResult.stdout).status).toBe('rolled-back');
      });
    });

    // evidence_role: supplemental
    // The consumer tree that a rejected rollback keeps is not an observation of a rollback guarantee.
    // contract_id: contract.ci-selective-distribution.application
    test('standalone public CLI keeps the consumer tree when rollback rejects an unbound option', async () => {
      await withFixture('a3-ci-github-distribution-cli-rollback-option-', (root) => {
        // Arrange
        const projectRoot = path.join(root, 'consumer');
        fs.mkdirSync(projectRoot);
        fs.writeFileSync(path.join(projectRoot, 'owned.txt'), 'consumer file\n');
        const cli = path.join(repositoryRoot, 'runtime/distribution/fetch-a3-ci-github.mjs');
        const before = snapshotTree(projectRoot);
        for (const flag of ['--manifest', '--manifest-url', '--preset', '--asset', '--source-root', '--source-revision', '--set', '--plan', '--approve']) {
          // Act
          const rejected = spawnSync(process.execPath, [cli, 'rollback', '--repo-root', projectRoot, '--transaction', 'unused', flag, 'unused'], { encoding: 'utf8' });
          // Assert
          expect(rejected.status, `${flag}: ${rejected.stderr}`).toBe(2);
          expect(snapshotTree(projectRoot), flag).toStrictEqual(before);
        }
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
    test('fetched selections deliver only the files of their closures', async () => {
      await withFixture('a3-ci-github-distribution-closure-', async (root) => {
        const release = prepareRelease(root);
        const projectRoot = path.join(root, 'consumer');
        fs.mkdirSync(projectRoot);
        const fetch = (requestedPresets, requestedAssets = []) => cliFetch({ projectRoot, manifestPath: release.manifestPath,
          requestedPresets, requestedAssets, sourceRoot: repositoryRoot });
        const closure = (presets, assets = []) => resolveDistributionSelection(release.manifest, presets, assets);
        const deliveredPaths = (distributionRoot) => {
          return fs.readdirSync(distributionRoot, { recursive: true, withFileTypes: true })
            .filter((entry) => !entry.isDirectory())
            .map((entry) => path.relative(distributionRoot, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
            .filter((relative) => !['manifest.json', 'receipt.json'].includes(relative));
        };
        const expectClosure = (result, presets, assets) => {
          const selected = closure(presets, assets);
          const expectedPaths = new Set(selected.flatMap((asset) => asset.files.map((file) => file.sourcePath)));
          const manifestBytes = fs.readFileSync(path.join(result.distributionRoot, 'manifest.json'));
          const receipt = JSON.parse(fs.readFileSync(path.join(result.distributionRoot, 'receipt.json'), 'utf8'));
          expect(manifestBytes).toStrictEqual(fs.readFileSync(release.manifestPath));
          expect(result.sourceRevision).toBe(release.manifest.sourceRevision);
          expect(result.selectedAssets).toStrictEqual(selected.map((asset) => asset.id).sort());
          expect(receipt).toMatchObject({
            sourceRevision: result.sourceRevision,
            manifestSha256: sha256(manifestBytes),
            selectedPresets: [...presets].sort(),
            selectedAssets: result.selectedAssets,
            files: result.files,
          });
          expect([...receipt.files].sort()).toStrictEqual([...expectedPaths].sort());
          expect(deliveredPaths(result.distributionRoot).sort()).toStrictEqual([...expectedPaths].sort());
          for (const relative of expectedPaths) {
            const filename = path.join(result.distributionRoot, relative);
            expect(fs.lstatSync(filename).isFile(), relative).toBe(true);
            expect(sha256(fs.readFileSync(filename)), relative).toBe(release.manifest.files[relative].sha256);
          }
        };
        const first = fetch(['release-request']);
        expectClosure(first, ['release-request']);
        const quality = fetch(['quality-gate']);
        expectClosure(quality, ['release-request', 'quality-gate']);
        const merged = fetch(['quality-gate'], ['runtime.adapter-materializer']);
        expect(merged.action).toBe('merged');
        expectClosure(merged, ['release-request', 'quality-gate'], ['runtime.adapter-materializer']);
      });
    });

    // evidence_role: supplemental
    // The asset lock, the preflight and the adapter materializer consume the delivered files; they are not observations of a delivery or verification guarantee.
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
