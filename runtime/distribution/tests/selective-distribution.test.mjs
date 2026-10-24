import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi, describe } from 'vitest';
import { applyDistributionPlan, fetchDistribution, loadDistributionManifest, resolveDistributionSelection, rollbackDistributionTransaction, validateDistributionManifest, verifyFetchedDistribution } from '../fetch-a3-ci-github.mjs';
import { snapshotTree } from '../../preset/tests/support/release-request-fixture.mjs';
import { readWorkflowSettings, renderWorkflowTemplate } from '../../preset/workflow-template.mjs';
import { repositoryRoot, yaml, planDistributionApplication, releaseTag, committedSourceRoot, sourceRevision, sha256, withFixture, prepareRelease } from "./selective-distribution.fixtures.mjs";

describe('distribution test fixtures', () => {
  describe('prepareRelease', () => {
    // evidence_role: supplemental
    // test_level: integration
    // integration_id: distribution-fixture-isolation
    test('consumer copies isolate manifest objects and all release bytes from later cases', async () => {
      // Arrange
      await withFixture('distribution-mutated-copy-', async (firstRoot) => {
        const first = prepareRelease(firstRoot);
        const files = (output) => fs.readdirSync(output, { recursive: true })
          .filter((name) => fs.statSync(path.join(output, name)).isFile());
        const bytes = new Map(files(first.output).map((name) => [name, fs.readFileSync(path.join(first.output, name))]));
        // Act
        first.manifest.sourceRevision = 'mutated';
        first.manifestBytes.fill(0);
        for (const name of bytes.keys()) fs.writeFileSync(path.join(first.output, name), 'mutated');
        await withFixture('distribution-clean-copy-', (secondRoot) => {
          const second = prepareRelease(secondRoot);
          // Assert
          expect(second.manifest.sourceRevision).toBe(sourceRevision);
          expect(second.manifest).not.toBe(first.manifest);
          expect(second.manifestBytes).not.toBe(first.manifestBytes);
          expect(second.manifestBytes).toEqual(bytes.get('a3-ci-github-distribution-manifest.json'));
          expect(files(second.output).sort()).toEqual([...bytes.keys()].sort());
          for (const [name, expected] of bytes) expect(fs.readFileSync(path.join(second.output, name))).toEqual(expected);
        });
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
    test('manifest validation rejects malformed authority identity files and dependency references', async () => {
      await withFixture('a3-ci-github-distribution-manifest-validation-', (root) => {
        const { manifest } = prepareRelease(root);
        const cases = [
          [null, /distribution-manifest-invalid/],
          [{ ...manifest, schemaVersion: '1' }, /distribution-manifest-contract-unsupported/],
          [{ ...manifest, repository: 'other/repository' }, /distribution-manifest-source-untrusted/],
          [{ ...manifest, sourceRevision: 'main' }, /distribution-manifest-source-revision-invalid/],
          [{ ...manifest, releaseTag: 'latest' }, /distribution-manifest-release-tag-invalid/],
          [{ ...manifest, assets: null }, /distribution-manifest-shape-invalid/],
        ];
        for (const [candidate, diagnostic] of cases) {
          expect(() => validateDistributionManifest(candidate)).toThrow(diagnostic);
        }
        for (const mutate of [
          (binding) => { binding.sourceRevision = 'a'.repeat(40); },
          (binding) => { binding.referencePlaceholder = '<unknown-workflow-sha>'; },
        ]) {
          const candidate = structuredClone(manifest);
          mutate(candidate.reusableWorkflows['.github/workflows/ci-quality.yml']);
          expect(() => validateDistributionManifest(candidate)).toThrow(/distribution-manifest-workflow-binding-invalid/);
        }
        const differentReference = structuredClone(manifest);
        differentReference.workflowReferences['quality-workflow-sha'] = 'a'.repeat(40);
        expect(() => validateDistributionManifest(differentReference)).toThrow(/distribution-manifest-workflow-binding-invalid/);
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
          ['runtime.preset', 'registry.ci-github', 'runtime.diagnostics'],
        );
        expect(directAssets.map((asset) => asset.id)).toStrictEqual(['registry.ci-github', 'runtime.diagnostics', 'runtime.preset']);
      });
    });
  });
});


describe("contract.ci-selective-distribution.application", () => {
  describe('provider-pin-companion', () => {
    // contract_id: contract.ci-selective-distribution.application
    test('planned provider pin companions are owned and restored with generated callers', async () => {
      await withFixture('distribution-provider-pins-', async (root) => {
        const release = prepareRelease(root);
        const projectRoot = path.join(root, 'consumer');
        fs.mkdirSync(projectRoot);
        const selection = { requestedPresets: ['release-request'], requestedAssets: [] };
        await fetchDistribution({ projectRoot, manifest: release.manifest, manifestBytes: release.manifestBytes,
          sourceRoot: repositoryRoot, ...selection });
        const options = { projectRoot, sourceRevision, ...selection };
        const plan = planDistributionApplication(options);
        const pins = plan.actions.find((entry) => entry.destination === '.ci/provider-action-pins.yml');
        expect(pins?.action).toBe('create');
        const applied = applyDistributionPlan({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest });
        expect(yaml.parse(fs.readFileSync(path.join(projectRoot, pins.destination), 'utf8'))['actions/upload-artifact'].commitSha)
          .toBe(release.manifest.workflowReferences['actions/upload-artifact']);
        expect(planDistributionApplication(options).actions.find((entry) => entry.destination === pins.destination).action).toBe('reuse');
        expect(rollbackDistributionTransaction({ projectRoot, transactionId: applied.transactionId }).status).toBe('rolled-back');
        expect(fs.existsSync(path.join(projectRoot, pins.destination))).toBe(false);
        const fresh = planDistributionApplication(options);
        expect(() => applyDistributionPlan({ projectRoot, planPath: fresh.planPath, approvalDigest: fresh.planDigest,
          beforeWrite: ({ entry }) => { if (entry.destination === pins.destination) throw new Error('pin-write-failed'); } }))
          .toThrow(/distribution-unknown-failure/);
        for (const entry of fresh.actions) expect(fs.existsSync(path.join(projectRoot, entry.destination))).toBe(false);
        applyDistributionPlan({ projectRoot, planPath: fresh.planPath, approvalDigest: fresh.planDigest });
        const pinPath = path.join(projectRoot, pins.destination);
        const priorBytes = `${fs.readFileSync(pinPath, 'utf8')}\n`;
        fs.writeFileSync(pinPath, priorBytes);
        expect(planDistributionApplication(options).actions.find((entry) => entry.destination === pins.destination).action).toBe('conflict');
        fs.writeFileSync(path.join(projectRoot, '.ci/ci-assets.lock.json'), JSON.stringify({
          schemaVersion: '1', kind: 'ci-github-asset-lock', sourceRevision,
          assets: fresh.actions.map((entry) => ({ path: entry.destination,
            appliedSha256: sha256(fs.readFileSync(path.join(projectRoot, entry.destination))) })),
        }));
        const update = planDistributionApplication(options);
        expect(update.actions.find((entry) => entry.destination === pins.destination).action).toBe('update');
        fs.writeFileSync(pinPath, `${priorBytes}# independent edit\n`);
        expect(() => applyDistributionPlan({ projectRoot, planPath: update.planPath, approvalDigest: update.planDigest }))
          .toThrow(/distribution-plan-input-changed/);
        fs.writeFileSync(pinPath, priorBytes);
        const updated = applyDistributionPlan({ projectRoot, planPath: update.planPath, approvalDigest: update.planDigest });
        expect(fs.readFileSync(pinPath, 'utf8')).toBe(pins.generatedContent);
        rollbackDistributionTransaction({ projectRoot, transactionId: updated.transactionId });
        expect(fs.readFileSync(pinPath, 'utf8')).toBe(priorBytes);
        await fetchDistribution({ projectRoot, manifest: release.manifest, manifestBytes: release.manifestBytes,
          sourceRoot: repositoryRoot, requestedPresets: ['quality-gate'], requestedAssets: [] });
        const quality = planDistributionApplication({ ...options, requestedPresets: ['quality-gate'] });
        expect(quality.actions.find((entry) => entry.destination === pins.destination).action).toBe('update');
      });
    });
    // contract_id: contract.ci-selective-distribution.application
    test('owned callers sharing a destination with an unfetched exclusive preset are planned from their own prior template', async () => {
      await withFixture('distribution-shared-destination-', async (root) => {
        const release = prepareRelease(root);
        const projectRoot = path.join(root, 'consumer');
        fs.mkdirSync(projectRoot);
        const destination = '.github/workflows/release-publication-caller.yml';
        expect(release.manifest.assets.filter((asset) => asset.files.some((entry) => entry.destination === destination))
          .map((asset) => asset.id)).toEqual(expect.arrayContaining(['workflow.asset-release-publication-caller', 'workflow.release-publication-caller']));
        const selection = { requestedPresets: ['release-publication'], requestedAssets: [] };
        await fetchDistribution({ projectRoot, manifest: release.manifest, manifestBytes: release.manifestBytes,
          sourceRoot: repositoryRoot, ...selection });
        const options = { projectRoot, sourceRevision, ...selection };
        const plan = planDistributionApplication(options);
        applyDistributionPlan({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest });
        fs.writeFileSync(path.join(projectRoot, '.ci/ci-assets.lock.json'), JSON.stringify({
          schemaVersion: '1', kind: 'ci-github-asset-lock', sourceRevision,
          assets: plan.actions.map((entry) => ({ path: entry.destination, appliedSha256: entry.generatedSha256 })) }));
        const replanned = planDistributionApplication(options);
        expect(replanned.actions.find((entry) => entry.destination === destination)).toMatchObject(
          { assetId: 'workflow.release-publication-caller', action: 'reuse' });
        expect(replanned.actions.every((entry) => entry.action === 'reuse')).toBe(true);
      });
    });
    // contract_id: contract.ci-selective-distribution.application
    test('missing prior distributions are classified without treating old schemas as current', async () => {
      await withFixture('distribution-prior-migration-', async (root) => {
        const release = prepareRelease(root);
        const projectRoot = path.join(root, 'consumer');
        fs.mkdirSync(projectRoot);
        const selection = { requestedPresets: ['quality-gate'], requestedAssets: [] };
        await fetchDistribution({ projectRoot, manifest: release.manifest, manifestBytes: release.manifestBytes,
          sourceRoot: repositoryRoot, ...selection });
        const options = { projectRoot, sourceRevision, ...selection };
        const plan = planDistributionApplication(options);
        applyDistributionPlan({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest });
        const priorRevision = 'b'.repeat(40);
        const lockPath = path.join(projectRoot, '.ci/ci-assets.lock.json');
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.writeFileSync(lockPath, JSON.stringify({ schemaVersion: '1', kind: 'ci-github-asset-lock', sourceRevision: priorRevision,
          assets: plan.actions.map((entry) => ({ path: entry.destination, appliedSha256: entry.generatedSha256 })) }));
        expect(() => planDistributionApplication(options)).toThrow(/distribution-local-manifest-missing/);
        const priorRoot = path.join(projectRoot, '.a3-skills/ci-github/distributions', priorRevision);
        fs.mkdirSync(priorRoot);
        fs.writeFileSync(path.join(priorRoot, 'manifest.json'), JSON.stringify({ schemaVersion: '1', kind: release.manifest.kind }));
        fs.writeFileSync(path.join(priorRoot, 'receipt.json'), '{}');
        expect(() => planDistributionApplication(options)).toThrow(/distribution-manifest-contract-unsupported/);
      });
    });
  });
  describe('workflow-template-generation', () => {
    test('normal generation and application need no Hosted evidence and preserve ownership checks', async () => {
      // Arrange
      await withFixture('distribution-template-generation-', async (root) => {
        const release = prepareRelease(root);
        const projectRoot = path.join(root, 'consumer');
        fs.mkdirSync(projectRoot);
        await fetchDistribution({ projectRoot, manifest: release.manifest,
          manifestBytes: Buffer.from(JSON.stringify(release.manifest)),
          requestedPresets: ['quality-gate'], requestedAssets: [], sourceRoot: repositoryRoot });
        const options = { projectRoot, sourceRevision, requestedPresets: ['quality-gate'], requestedAssets: [] };
        // Act / Assert
        const workflowPath = path.join(projectRoot, '.github/workflows/quality-gate.yml');
        fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
        fs.copyFileSync(path.join(repositoryRoot, 'workflows/quality/quality-gate.yml'), workflowPath);
        const independentBytes = fs.readFileSync(workflowPath);
        const unmanaged = planDistributionApplication(options);
        expect(fs.readFileSync(workflowPath)).toEqual(independentBytes);
        expect(unmanaged.actions.map((entry) => entry.action)).toEqual(['conflict']);
        expect(() => applyDistributionPlan({ projectRoot, planPath: unmanaged.planPath, approvalDigest: unmanaged.planDigest })).toThrow(/plan-has-conflicts/);
        expect(fs.readFileSync(workflowPath, 'utf8')).toContain('<quality-workflow-sha>');
        fs.rmSync(workflowPath);
        const plan = planDistributionApplication(options);
        expect(plan.actions.every((entry) => entry.generatedSha256 !== entry.sourceSha256)).toBe(true);
        expect(plan.actions[0].generatedContent).toContain(`ci-quality.yml@${sourceRevision}`);
        expect(plan.actions[0].generatedContent).not.toMatch(/<[a-zA-Z][a-zA-Z0-9._-]*>/);
        const applied = applyDistributionPlan({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest });
        expect(applied.nextSteps).toEqual(['generate-asset-lock', 'lint', 'preflight', 'consumer-contract-tests']);
        expect(fs.readFileSync(workflowPath, 'utf8')).toBe(plan.actions[0].generatedContent);
        expect(fs.existsSync(path.join(projectRoot, '.ci/ci-assets.lock.json'))).toBe(false);
      });
    });
    // contract_id: contract.ci-selective-distribution.application
    test('workflow generation safely resolves values and preserves only declared caller settings', () => {
      const template = 'on:\n  push:\n    branches: [<protected-branch>]\njobs:\n  quality:\n    uses: provider/workflow@<quality-workflow-sha>\n    with:\n      runner: <versioned-runner>\n      enabled: <feature-enabled>\n      optional: <optional-value>\n';
      const references = { 'quality-workflow-sha': 'a'.repeat(40) };
      const values = { 'protected-branch': ['main', 'develop'], 'versioned-runner': 'ubuntu-24.04\npermissions: write-all', 'feature-enabled': false };
      const rendered = renderWorkflowTemplate({ yaml, template, references, values, emptyAllowed: ['optional-value'] });
      const observed = yaml.parse(rendered);
      expect(observed.jobs.quality.uses).toBe(`provider/workflow@${'a'.repeat(40)}`);
      expect(observed.on.push.branches).toStrictEqual(['main', 'develop']);
      expect(observed.jobs.quality.with.enabled).toBe(false);
      expect(observed.jobs.quality.with.runner).toBe(values['versioned-runner']);
      expect(observed.permissions).toBeUndefined();
      const extracted = readWorkflowSettings({ yaml, template, current: rendered });
      expect(extracted.values['protected-branch']).toStrictEqual(['main', 'develop']);
      expect(extracted.values['versioned-runner']).toBe(values['versioned-runner']);
      expect(extracted.values['quality-workflow-sha']).toBeUndefined();
      expect(() => renderWorkflowTemplate({ yaml, template, references, values: { ...values, unknown: 'x' }, emptyAllowed: ['optional-value'] })).toThrow(/setting-unknown/);
      // A setting carried from the previous template but retired from the new one is dropped instead of blocking the update.
      expect(yaml.parse(renderWorkflowTemplate({ yaml, template, references, values, carriedValues: { 'retired-setting': '', 'feature-enabled': true }, emptyAllowed: ['optional-value'] })).jobs.quality.with.enabled).toBe(false);
      expect(() => renderWorkflowTemplate({ yaml, template, references, values: { ...values, 'feature-enabled': 'false' }, emptyAllowed: ['optional-value'] })).toThrow(/setting-invalid/);
      expect(() => renderWorkflowTemplate({ yaml, template, references, values: {}, emptyAllowed: ['optional-value'] })).toThrow(/setting-missing/);
      const drifted = structuredClone(observed);
      drifted.jobs.quality.permissions = 'write-all';
      expect(() => readWorkflowSettings({ yaml, template, current: yaml.stringify(drifted) })).toThrow(/structure-conflict/);
      expect(renderWorkflowTemplate({ yaml, template, references, values, emptyAllowed: ['optional-value'] })).toBe(rendered);
    });
    // contract_id: contract.ci-selective-distribution.application
    test('workflow generation expands only a matrix include into profile maps and reads them back', () => {
      const template = 'jobs:\n  quality:\n    strategy:\n      matrix:\n        include: <quality-profiles>\n    with:\n      runner: <versioned-runner>\n      language-profile: ${{ matrix.language-profile }}\n';
      const profiles = [{ 'language-profile': 'rust', 'toolchain-version': '1.90.0' }, { 'language-profile': 'python', 'uv-version': '0.8.0' }];
      const values = { 'quality-profiles': profiles, 'versioned-runner': 'ubuntu-24.04' };
      // Act
      const rendered = renderWorkflowTemplate({ yaml, template, values });
      // Assert
      expect(yaml.parse(rendered).jobs.quality.strategy.matrix.include).toStrictEqual(profiles);
      expect(yaml.parse(rendered).jobs.quality.with['language-profile']).toBe('${{ matrix.language-profile }}');
      expect(readWorkflowSettings({ yaml, template, current: rendered }).values['quality-profiles']).toStrictEqual(profiles);
      expect(yaml.parse(renderWorkflowTemplate({ yaml, template, values: { ...values, 'quality-profiles': [{ 'language-profile': 'rust', 'uv-version': '' }] } })).jobs.quality.strategy.matrix.include)
        .toStrictEqual([{ 'language-profile': 'rust', 'uv-version': '' }]);
      for (const invalid of ['rust', [], [{}], [{ 'language-profile': 1 }], [{ 'Language-Profile': 'rust' }], [{ nested: { a: 'b' } }]]) {
        expect(() => renderWorkflowTemplate({ yaml, template, values: { ...values, 'quality-profiles': invalid } }), JSON.stringify(invalid)).toThrow(/setting-invalid:quality-profiles/);
      }
      const drifted = yaml.parse(rendered);
      drifted.jobs.quality.strategy.matrix.include = [{ 'language-profile': ['rust'] }];
      expect(() => readWorkflowSettings({ yaml, template, current: yaml.stringify(drifted) })).toThrow(/setting-invalid:quality-profiles/);
      expect(() => renderWorkflowTemplate({ yaml, template: template.replace('include: <quality-profiles>', 'other: <quality-profiles>'), values })).toThrow(/setting-invalid:quality-profiles/);
    });
  });
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
          expect(optionalWorkflow).toContain(`uses: a3-suite/a3-ci-github/.github/workflows/ci-quality-platforms.yml@${sourceRevision}`);
          expect(optionalWorkflow).not.toMatch(/ci-platform-matrix@|id: trusted-assets/);
          expect(optionalWorkflow).not.toMatch(/CoreLoader|pyyaml|\.a3-skills\//);
          for (const [relative, text] of Object.entries(configurations)) {
            expect(fs.readFileSync(path.join(projectRoot, relative), 'utf8')).toBe(text);
          }
          expect(fs.readFileSync(existingFile, 'utf8')).toBe('consumer-owned documentation\n');
          expect(rollbackDistributionTransaction({ projectRoot, transactionId: optionalApplied.transactionId }).status).toBe('rolled-back');
          expect(ordinaryFiles(projectRoot).sort()).toStrictEqual(['.ci/platform-manifest.yml', '.ci/quality-platforms.yml', 'README.md']);
          const profilesSelection = { requestedPresets: ['quality-gate-profiles'], requestedAssets: [] };
          await fetchDistribution({ projectRoot, manifest: release.manifest, manifestBytes: release.manifestBytes,
            sourceRoot: repositoryRoot, ...profilesSelection });
          const profilesPlan = planDistributionApplication({ projectRoot, sourceRevision, ...profilesSelection });
          const profilesApplied = applyDistributionPlan({ projectRoot, planPath: profilesPlan.planPath, approvalDigest: profilesPlan.planDigest });
          expect(ordinaryFiles(projectRoot).sort()).toStrictEqual([
            '.ci/platform-manifest.yml', '.ci/quality-platforms.yml', '.github/workflows/quality-gate-profiles.yml', 'README.md',
          ]);
          const profilesWorkflow = yaml.parse(fs.readFileSync(path.join(projectRoot, '.github/workflows/quality-gate-profiles.yml'), 'utf8'));
          expect(profilesWorkflow.jobs.quality.uses).toBe(`a3-suite/a3-ci-github/.github/workflows/ci-quality.yml@${sourceRevision}`);
          expect(profilesWorkflow.jobs.quality.strategy.matrix.include.map((entry) => entry['language-profile'])).toStrictEqual(['rust', 'python']);
          expect(profilesWorkflow.jobs['profiles-summary'].name).toBe('quality-gate-profiles / summary');
          expect(rollbackDistributionTransaction({ projectRoot, transactionId: profilesApplied.transactionId }).status).toBe('rolled-back');
          expect(ordinaryFiles(projectRoot).sort()).toStrictEqual(['.ci/platform-manifest.yml', '.ci/quality-platforms.yml', 'README.md']);
          const releaseSelection = { requestedPresets: ['release-request', 'release-publication'], requestedAssets: [] };
          await fetchDistribution({ projectRoot, manifest: release.manifest, manifestBytes: release.manifestBytes,
            sourceRoot: repositoryRoot, ...releaseSelection });
          const releasePlan = planDistributionApplication({ projectRoot, sourceRevision, ...releaseSelection });
          const releaseApplied = applyDistributionPlan({ projectRoot, planPath: releasePlan.planPath, approvalDigest: releasePlan.planDigest });
          expect(ordinaryFiles(projectRoot).sort()).toStrictEqual([
            '.ci/platform-manifest.yml', '.ci/provider-action-pins.yml', '.ci/quality-platforms.yml',
            '.github/workflows/release-publication-caller.yml', '.github/workflows/release-publication-request.yml',
            '.github/workflows/release-request-tag.yml', 'README.md',
          ]);
          expect(fs.existsSync(path.join(projectRoot, '.github/workflows/release-publication.yml'))).toBe(false);
          const publication = fs.readFileSync(path.join(projectRoot, '.github/workflows/release-publication-caller.yml'), 'utf8');
          expect(publication).toContain(`ci-release-publication.yml@${sourceRevision}`);
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
            '.ci/platform-manifest.yml', '.ci/provider-action-pins.yml', '.ci/quality-platforms.yml',
            '.github/workflows/package-publication-caller.yml', '.github/workflows/package-publication-request.yml', 'README.md',
          ]);
          expect(fs.existsSync(path.join(projectRoot, '.github/workflows/package-publication.yml'))).toBe(false);
          expect(fs.existsSync(path.join(projectRoot, '.github/workflows/package-preparation.yml'))).toBe(false);
          const packageCaller = fs.readFileSync(path.join(projectRoot, '.github/workflows/package-publication-caller.yml'), 'utf8');
          expect(packageCaller).toContain(`ci-package-publication.yml@${sourceRevision}`);
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
            requestedAssets: ['workflow.quality-gate', 'runtime.quality-workflow', 'runtime.preset', 'registry.ci-github', 'runtime.diagnostics'],
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
          requestedAssets: ['workflow.quality-gate', 'runtime.quality-workflow', 'runtime.preset', 'registry.ci-github', 'runtime.diagnostics'],
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
          requestedAssets: ['workflow.quality-gate', 'runtime.quality-workflow', 'runtime.preset', 'registry.ci-github', 'runtime.diagnostics'],
          sourceRoot: repositoryRoot,
        });
        expect(() => planDistributionApplication({
            projectRoot,
            sourceRevision,
            requestedPresets: [],
            requestedAssets: ['workflow.quality-gate', 'runtime.quality-workflow', 'runtime.preset', 'registry.ci-github', 'runtime.diagnostics'],
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
            requestedAssets: ['workflow.quality-gate', 'runtime.quality-workflow', 'runtime.preset', 'registry.ci-github', 'runtime.diagnostics'],
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
        const originalRemove = fs.rmSync;
        let failure;
        fs.rmSync = (target, options) => {
          if (target === path.join(projectRoot, '.a3-skills/ci-github/apply.lock')) throw new Error('private cleanup error');
          return originalRemove(target, options);
        };
        try {
          applyDistributionPlan({
            projectRoot,
            planPath: plan.planPath,
            approvalDigest: plan.planDigest,
            beforeWrite: ({ index }) => {
              if (index !== 1) return;
              fs.mkdirSync(path.dirname(changedPath), { recursive: true });
              fs.writeFileSync(changedPath, 'changed-after-plan\n');
            },
          });
        } catch (error) { failure = error; }
        finally { fs.rmSync = originalRemove; }
        expect(failure.message).toMatch(/distribution-plan-input-changed/);
        expect(failure.details.cleanup).toBe('lock-cleanup-failed');
        expect(failure.details.rollback).toBe('restored');
        const retainedLock = path.join(projectRoot, '.a3-skills/ci-github/apply.lock');
        expect(fs.existsSync(retainedLock)).toBe(true);
        fs.rmSync(retainedLock, { force: true });
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
  });
});


describe("contract.ci-selective-distribution.delivery", () => {
  describe("selective-distribution", () => {

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
          expect(fs.existsSync(path.join(merged.distributionRoot, 'skills/ci-github/assets/registry/ci-distribution-assets.yml'))).toBeTruthy();
          expect(fs.existsSync(path.join(merged.distributionRoot, 'lint-rules/a3-lint/ci_github_workflow_name_matches_file.lua'))).toBeTruthy();
          expect(fs.existsSync(path.join(merged.distributionRoot, 'lint-rules/a3-lint/shared/ci_github_yaml.lua'))).toBeTruthy();
          expect(fs.existsSync(path.join(merged.distributionRoot, 'lint-rules/a3-lint/ci_github_action_runtime_contract.lua'))).toBe(false);
          expect(fs.existsSync(path.join(merged.distributionRoot, 'lint-rules/repository'))).toBe(false);
          expect(fs.existsSync(path.join(merged.distributionRoot, 'runtime/repository/check-provider-references.mjs'))).toBe(false);
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
            await expect(fetchDistribution({ ...options, download })).rejects.toThrow('distribution-lock-cleanup-failed');
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
    test('fetch retains validation failure and cached files when lock and staging cleanup fail', async () => {
      await withFixture('distribution-primary-cleanup-', async (root) => {
        const release = prepareRelease(root);
        for (const operation of ['lock', 'staging', 'both']) {
          const projectRoot = path.join(root, operation);
          fs.mkdirSync(projectRoot);
          const options = { projectRoot, manifest: release.manifest, manifestBytes: release.manifestBytes,
            requestedPresets: ['release-request'], requestedAssets: [] };
          const fetched = await fetchDistribution({ ...options, sourceRoot: committedSourceRoot });
          const before = snapshotTree(fetched.distributionRoot);
          const originalRemove = fs.rmSync;
          let failure;
          const cleanup = vi.spyOn(fs, 'rmSync').mockImplementation((target, removeOptions) => {
            const lock = target === path.join(fetched.distributionRoot, '.fetch.lock');
            const staging = path.basename(target).startsWith('.staging-');
            if ((lock && operation !== 'staging') || (staging && operation !== 'lock')) throw new Error('private cleanup failure');
            return originalRemove(target, removeOptions);
          });
          try {
            await fetchDistribution({ ...options, requestedPresets: ['quality-gate'], download: async () => Buffer.from('corrupt') });
          } catch (error) { failure = error; }
          finally { cleanup.mockRestore(); }
          expect(failure.message).toMatch(/^distribution-file-integrity-mismatch:/);
          expect(failure.details.write).toBe('not-started');
          expect(failure.details.cleanupFailures).toEqual(operation === 'lock' ? ['lock-remove']
            : operation === 'staging' ? ['staging-remove'] : ['lock-remove', 'staging-remove']);
          const after = snapshotTree(fetched.distributionRoot);
          delete after['.fetch.lock'];
          expect(after).toEqual(before);
          expect(verifyFetchedDistribution({ projectRoot, sourceRevision }).status).toBe('verified');
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
          ['opaque transport failure', { failure: 'transport unavailable' }, /distribution-download-failed:network-result-unknown/],
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
        const oldManagedBytes = Buffer.from(canonical.toString('utf8').replaceAll('ubuntu-24.04', 'ubuntu-22.04'));
        fs.writeFileSync(workflow, oldManagedBytes);
        writeOwnership(oldManagedBytes);
        const ownershipBefore = fs.readFileSync(lockPath);
        const preserved = planDistributionApplication({ ...options, settings: {} });
        expect(preserved.actions.map((entry) => entry.action)).toEqual(['reuse']);
        expect(preserved.actions[0].generatedContent).toBe(oldManagedBytes.toString('utf8'));
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



describe('contract.ci-selective-distribution.application', () => {
  describe('selective-distribution-recovery', () => {
    // evidence_role: contract
    // test_level: integration
    // contract_id: contract.ci-selective-distribution.application
    // integration_id: selective-distribution-recovery
    test('rollback retains its original rejection when owned lock cleanup fails', async () => {
      await withFixture('distribution-rollback-cleanup-', async (projectRoot) => {
        const stateRoot = path.join(projectRoot, '.a3-skills/ci-github');
        fs.mkdirSync(stateRoot, { recursive: true });
        const existing = path.join(projectRoot, 'existing-state');
        fs.writeFileSync(existing, 'preserved\n');
        const transactionId = '1-123456789abc';
        expect(() => rollbackDistributionTransaction({ projectRoot, transactionId })).toThrow('distribution-transaction-missing');
        const lock = path.join(stateRoot, 'apply.lock');
        const originalRemove = fs.rmSync;
        const cleanup = vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
          if (target === lock) throw new Error('private lock removal failure');
          return originalRemove(target, options);
        });
        let failure;
        try { rollbackDistributionTransaction({ projectRoot, transactionId }); }
        catch (error) { failure = error; }
        finally { cleanup.mockRestore(); }
        expect(failure.message).toBe('distribution-transaction-missing');
        expect(failure.details).toMatchObject({ transactionId, write: 'not-started', rollback: 'unavailable',
          cleanup: 'lock-cleanup-failed', cleanupFailures: ['lock-remove'] });
        expect(fs.existsSync(lock)).toBe(true);
        expect(fs.readFileSync(existing, 'utf8')).toBe('preserved\n');
      });
    });

    // evidence_role: contract
    // test_level: integration
    // contract_id: contract.ci-selective-distribution.application
    // integration_id: selective-distribution-recovery
    test('successful apply and rollback report cleanup failure with the completed transaction state', async () => {
      await withFixture('distribution-completed-cleanup-', async (root) => {
        const release = prepareRelease(root);
        for (const operation of ['apply', 'rollback']) {
          const projectRoot = path.join(root, operation);
          fs.mkdirSync(projectRoot);
          await fetchDistribution({ projectRoot, manifest: release.manifest, manifestBytes: release.manifestBytes,
            requestedPresets: ['release-request'], requestedAssets: [], sourceRoot: committedSourceRoot });
          const plan = planDistributionApplication({ projectRoot, sourceRevision, requestedPresets: ['release-request'], requestedAssets: [] });
          const apply = () => applyDistributionPlan({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest });
          const applied = operation === 'rollback' ? apply() : undefined;
          const lock = path.join(projectRoot, '.a3-skills/ci-github/apply.lock');
          const originalRemove = fs.rmSync;
          const cleanup = vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
            if (target === lock) throw new Error('private lock removal failure');
            return originalRemove(target, options);
          });
          let failure;
          try {
            if (operation === 'apply') apply();
            else rollbackDistributionTransaction({ projectRoot, transactionId: applied.transactionId });
          } catch (error) { failure = error; }
          finally { cleanup.mockRestore(); }
          expect(failure.message).toBe('distribution-lock-cleanup-failed');
          expect(failure.details.write).toBe(operation === 'apply' ? 'applied' : 'rolled-back');
          expect(failure.details.rollback).toBe(operation === 'apply' ? 'not-required' : 'restored');
          const transactionId = failure.details.transactionId;
          expect(transactionId).toMatch(/^[0-9]+-[0-9a-f]{12}$/);
          const transaction = JSON.parse(fs.readFileSync(path.join(projectRoot,
            '.a3-skills/ci-github/transactions', transactionId, 'transaction.json'), 'utf8'));
          expect(transaction.status).toBe(operation === 'apply' ? 'applied' : 'rolled-back');
          for (const entry of plan.actions) {
            const target = path.join(projectRoot, entry.destination);
            if (operation === 'apply') expect(fs.readFileSync(target, 'utf8')).toBe(entry.generatedContent);
            else expect(fs.existsSync(target)).toBe(false);
          }
          expect(fs.existsSync(lock)).toBe(true);
        }
      });
    });

    // evidence_role: contract
    // test_level: integration
    // contract_id: contract.ci-selective-distribution.application
    // integration_id: selective-distribution-recovery
    test('rollback retains the restoration error when recording recovery state also fails', async () => {
      await withFixture('distribution-rollback-record-', async (root) => {
        const release = prepareRelease(root);
        const projectRoot = path.join(root, 'consumer');
        fs.mkdirSync(projectRoot);
        await fetchDistribution({ projectRoot, manifest: release.manifest, manifestBytes: release.manifestBytes,
          requestedPresets: ['release-request'], requestedAssets: [], sourceRoot: committedSourceRoot });
        const plan = planDistributionApplication({ projectRoot, sourceRevision, requestedPresets: ['release-request'], requestedAssets: [] });
        const applied = applyDistributionPlan({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest });
        const transactionPath = path.join(projectRoot, '.a3-skills/ci-github/transactions', applied.transactionId, 'transaction.json');
        const target = path.join(projectRoot, plan.actions.at(-1).destination);
        const before = fs.readFileSync(target);
        const originalFailure = new Error('private restoration error');
        const lockPath = path.join(projectRoot, '.a3-skills/ci-github/apply.lock');
        for (const lockCleanupFails of [false, true]) {
          let restorationFailed = false;
          const originalRemove = fs.rmSync;
          const originalRename = fs.renameSync;
          const remove = vi.spyOn(fs, 'rmSync').mockImplementation((filename, options) => {
            if (filename === target) { restorationFailed = true; throw originalFailure; }
            if (filename === lockPath && lockCleanupFails) throw new Error('private lock cleanup failure');
            return originalRemove(filename, options);
          });
          const record = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
            if (destination === transactionPath && restorationFailed) throw new Error('private record failure');
            return originalRename(source, destination);
          });
          let failure;
          try { rollbackDistributionTransaction({ projectRoot, transactionId: applied.transactionId }); }
          catch (error) { failure = error; }
          finally { remove.mockRestore(); record.mockRestore(); }
          expect(failure.message).toBe('distribution-unknown-failure');
          expect(failure.cause).toBe(originalFailure);
          expect(failure.details).toMatchObject({ transactionId: applied.transactionId,
            write: 'partial-output', rollback: 'failed',
            cleanup: lockCleanupFails ? 'lock-cleanup-failed' : 'transaction-record-write-failed' });
          if (lockCleanupFails) expect(failure.details).toMatchObject({
            priorCleanup: 'transaction-record-write-failed', cleanupFailures: ['lock-remove'],
          });
          expect(fs.readFileSync(target)).toEqual(before);
          expect(JSON.parse(fs.readFileSync(transactionPath, 'utf8')).status).toBe('rolling-back');
          expect(fs.existsSync(lockPath)).toBe(lockCleanupFails);
        }
      });
    });
  });
});
