import fs from 'node:fs';
import path from 'node:path';
import { expect, test, describe } from 'vitest';
import { applyDistributionPlan, fetchDistribution, resolveDistributionSelection, rollbackDistributionTransaction, verifyFetchedDistribution } from '../fetch-a3-ci-github.mjs';
import { snapshotTree } from '../../preset/tests/support/release-request-fixture.mjs';
import { readWorkflowSettings, renderWorkflowTemplate } from '../../preset/workflow-template.mjs';
import { cliApply, cliFetch, cliFetchPeer, cliPlan, cliRollback, cliVerify, createConsumer, fixturePlanSettings, writeManifest, repositoryRoot, yaml, planDistributionApplication, releaseTag, committedSourceRoot, sourceRevision, sha256, withFixture, prepareRelease } from "./selective-distribution.fixtures.mjs";

const failureOf = (run) => {
  try { run(); } catch (error) { return error; }
  throw new Error('expected the distribution CLI to fail');
};

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
        const release = prepareRelease(root);
        const fetchSelection = (name, requestedPresets, requestedAssets) => cliFetch({ projectRoot: createConsumer(root, name),
          manifestPath: release.manifestPath, requestedPresets, requestedAssets, sourceRoot: repositoryRoot });
        const workflowSources = (result) => result.files.filter((source) => source.startsWith('.github/workflows/')).sort();
        const expected = {
          'quality-gate': ['ci-quality.yml'],
          'release-request': [],
          'release-publication': ['ci-release-publication.yml'],
          'package-publication': ['ci-package-preparation.yml', 'ci-package-publication.yml'],
        };
        for (const [preset, workflows] of Object.entries(expected)) {
          const selected = fetchSelection(preset, [preset], []);
          expect(selected.selectedAssets).not.toContain('runtime.adapter-materializer');
          expect(workflowSources(selected)).toStrictEqual(workflows.map((file) => `.github/workflows/${file}`).sort());
        }
        expect(() => fetchSelection('platforms-without-runtime', ['quality-gate'], ['workflow.quality-gate-platforms']))
          .toThrow(/^distribution-dependency-missing$/);
        const platforms = fetchSelection('platforms', ['quality-gate'], ['workflow.quality-gate-platforms', 'runtime.quality-platforms-workflow']);
        expect(workflowSources(platforms)).toStrictEqual(['.github/workflows/ci-quality-platforms.yml', '.github/workflows/ci-quality.yml']);
        expect(() => fetchSelection('materializer', [], ['runtime.adapter-materializer'])).toThrow(/^distribution-dependency-missing$/);
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
        const mutated = (mutate) => {
          const candidate = structuredClone(manifest);
          mutate(candidate);
          return candidate;
        };
        const cases = [
          [null, 'distribution-manifest-invalid'],
          [{ ...manifest, schemaVersion: '1' }, 'distribution-manifest-contract-unsupported'],
          [{ ...manifest, repository: 'other/repository' }, 'distribution-manifest-source-untrusted'],
          [{ ...manifest, sourceRevision: 'main' }, 'distribution-manifest-source-revision-invalid'],
          [{ ...manifest, releaseTag: 'latest' }, 'distribution-manifest-release-tag-invalid'],
          [{ ...manifest, assets: null }, 'distribution-manifest-shape-invalid'],
          [mutated((candidate) => { candidate.reusableWorkflows['.github/workflows/ci-quality.yml'].sourceRevision = 'a'.repeat(40); }), 'distribution-manifest-workflow-binding-invalid'],
          [mutated((candidate) => { candidate.reusableWorkflows['.github/workflows/ci-quality.yml'].referencePlaceholder = '<unknown-workflow-sha>'; }), 'distribution-manifest-workflow-binding-invalid'],
          [mutated((candidate) => { candidate.workflowReferences['quality-workflow-sha'] = 'a'.repeat(40); }), 'distribution-manifest-workflow-binding-invalid'],
          [mutated((candidate) => { candidate.assets.push(structuredClone(candidate.assets[0])); }), 'distribution-manifest-asset-invalid'],
          [mutated((candidate) => { candidate.files[candidate.assets[0].files[0].sourcePath].sha256 = 'invalid'; }), 'distribution-manifest-file-invalid'],
          [mutated((candidate) => { candidate.assets[0].dependencies.push('unknown'); }), 'distribution-dependency-unknown'],
          [mutated((candidate) => { candidate.presets[0].requiredAssets.push('unknown'); }), 'distribution-preset-asset-unknown'],
        ];
        for (const [index, [candidate, diagnostic]] of cases.entries()) {
          const projectRoot = createConsumer(root, `consumer-${index}`);
          expect(() => cliFetch({ projectRoot, manifestPath: writeManifest(root, candidate, `manifest-${index}.json`),
            requestedPresets: ['quality-gate'], sourceRoot: repositoryRoot }), diagnostic).toThrow(new RegExp(`^${diagnostic}$`));
          expect(fs.existsSync(path.join(projectRoot, '.a3-skills/ci-github/distributions')), diagnostic).toBe(false);
        }
      });
    });

    // contract_id: contract.ci-selective-distribution.delivery
    test('remote manifest loading confines the Release URL and release tag mapping', async () => {
      await withFixture('a3-ci-github-distribution-remote-manifest-', async (root) => {
        const release = prepareRelease(root);
        const faults = { transport: { manifestPath: release.manifestPath, sourceRoot: committedSourceRoot, sourceRevision } };
        const fetchRemote = (name, options) => cliFetch({ projectRoot: createConsumer(root, name), requestedPresets: ['release-request'], faults, ...options });
        const validUrl = `https://github.com/a3-suite/a3-ci-github/releases/download/${releaseTag}/a3-ci-github-distribution-manifest.json`;
        expect(fetchRemote('valid', { manifestUrl: validUrl }).sourceRevision).toBe(sourceRevision);
        expect(() => fetchRemote('tag-mismatch', {
          manifestUrl: 'https://github.com/a3-suite/a3-ci-github/releases/download/v9.9.9/a3-ci-github-distribution-manifest.json',
        })).toThrow(/^distribution-manifest-release-url-mismatch$/);
        expect(() => fetchRemote('untrusted', { manifestUrl: 'https://example.invalid/manifest.json' })).toThrow(/^distribution-manifest-url-untrusted$/);
        expect(() => fetchRemote('exclusive', { manifestPath: release.manifestPath, manifestUrl: validUrl })).toThrow(/^distribution-manifest-source-exclusive$/);
      });
    });
  });
});


describe("contract.ci-selective-distribution.selection", () => {
  describe("selective-distribution", () => {
    // contract_id: contract.ci-selective-distribution.selection
    test('preset selection closes dependencies while direct asset selection reports missing dependencies', async () => {
      await withFixture('a3-ci-github-distribution-selection-', (root) => {
        const release = prepareRelease(root);
        const fetchSelection = (name, requestedPresets, requestedAssets, manifestPath = release.manifestPath) => cliFetch({
          projectRoot: createConsumer(root, name), manifestPath, requestedPresets, requestedAssets, sourceRoot: repositoryRoot });
        const presetAssets = fetchSelection('preset', ['quality-gate'], []).selectedAssets;
        expect(presetAssets).toContain('registry.ci-github');
        expect(presetAssets).toContain('workflow.quality-gate');
        for (const [name, requestedPresets, requestedAssets, diagnostic, comparison] of [
          ['empty', [], [], 'distribution-selection-required'],
          ['unknown-preset', ['unknown'], [], 'distribution-preset-unknown'],
          ['unknown-asset', [], ['unknown'], 'distribution-asset-unknown'],
          ['missing-dependency', [], ['runtime.preset'], 'distribution-dependency-missing',
            { field: 'runtime.preset.dependencies', expected: 'registry.ci-github', observed: 'not-selected' }],
        ]) {
          const projectRoot = createConsumer(root, name);
          const before = snapshotTree(projectRoot);
          const failure = failureOf(() => cliFetch({ projectRoot, manifestPath: release.manifestPath, requestedPresets, requestedAssets, sourceRoot: repositoryRoot }));
          expect(failure.message, name).toBe(diagnostic);
          if (comparison) expect(failure.evidence.comparison, name).toMatchObject(comparison);
          expect(snapshotTree(projectRoot), name).toStrictEqual(before);
        }
        const cyclic = structuredClone(release.manifest);
        cyclic.assets.find((asset) => asset.id === 'registry.ci-github').dependencies.push('runtime.preset');
        expect(() => fetchSelection('cyclic', ['quality-gate'], [], writeManifest(root, cyclic))).toThrow(/^distribution-dependency-cycle$/);
        expect(fetchSelection('direct', [], ['runtime.preset', 'registry.ci-github', 'runtime.diagnostics']).selectedAssets)
          .toStrictEqual(['registry.ci-github', 'runtime.diagnostics', 'runtime.preset']);
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
        const projectRoot = createConsumer(root);
        const selection = { requestedPresets: ['release-request'], requestedAssets: [] };
        cliFetch({ projectRoot, manifestPath: release.manifestPath, sourceRoot: repositoryRoot, ...selection });
        const options = { projectRoot, sourceRevision, ...selection };
        const plan = cliPlan(options);
        const pins = plan.actions.find((entry) => entry.destination === '.ci/provider-action-pins.yml');
        expect(pins?.action).toBe('create');
        const applied = cliApply({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest });
        expect(yaml.parse(fs.readFileSync(path.join(projectRoot, pins.destination), 'utf8'))['actions/upload-artifact'].commitSha)
          .toBe(release.manifest.workflowReferences['actions/upload-artifact']);
        expect(cliPlan(options).actions.find((entry) => entry.destination === pins.destination).action).toBe('reuse');
        expect(cliRollback({ projectRoot, transactionId: applied.transactionId }).status).toBe('rolled-back');
        expect(fs.existsSync(path.join(projectRoot, pins.destination))).toBe(false);
        const fresh = cliPlan(options);
        expect(() => cliApply({ projectRoot, planPath: fresh.planPath, approvalDigest: fresh.planDigest,
          faults: { transactionHooks: [{ status: 'applying', destination: pins.destination, throw: true }] } }))
          .toThrow(/^distribution-unknown-failure$/);
        for (const entry of fresh.actions) expect(fs.existsSync(path.join(projectRoot, entry.destination))).toBe(false);
        cliApply({ projectRoot, planPath: fresh.planPath, approvalDigest: fresh.planDigest });
        const pinPath = path.join(projectRoot, pins.destination);
        const priorBytes = `${fs.readFileSync(pinPath, 'utf8')}\n`;
        fs.writeFileSync(pinPath, priorBytes);
        expect(cliPlan(options).actions.find((entry) => entry.destination === pins.destination).action).toBe('conflict');
        fs.writeFileSync(path.join(projectRoot, '.ci/ci-assets.lock.json'), JSON.stringify({
          schemaVersion: '1', kind: 'ci-github-asset-lock', sourceRevision,
          assets: fresh.actions.map((entry) => ({ path: entry.destination,
            appliedSha256: sha256(fs.readFileSync(path.join(projectRoot, entry.destination))) })),
        }));
        const update = cliPlan(options);
        expect(update.actions.find((entry) => entry.destination === pins.destination).action).toBe('update');
        fs.writeFileSync(pinPath, `${priorBytes}# independent edit\n`);
        expect(() => cliApply({ projectRoot, planPath: update.planPath, approvalDigest: update.planDigest }))
          .toThrow(/^distribution-plan-input-changed$/);
        fs.writeFileSync(pinPath, priorBytes);
        const updated = cliApply({ projectRoot, planPath: update.planPath, approvalDigest: update.planDigest });
        expect(fs.readFileSync(pinPath, 'utf8')).toBe(pins.generatedContent);
        cliRollback({ projectRoot, transactionId: updated.transactionId });
        expect(fs.readFileSync(pinPath, 'utf8')).toBe(priorBytes);
        cliFetch({ projectRoot, manifestPath: release.manifestPath, sourceRoot: repositoryRoot, requestedPresets: ['quality-gate'] });
        const quality = cliPlan({ ...options, requestedPresets: ['quality-gate'] });
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
    // contract_id: contract.ci-selective-distribution.plan
    test('missing prior distributions are classified without treating old schemas as current', async () => {
      await withFixture('distribution-prior-migration-', async (root) => {
        const release = prepareRelease(root);
        const projectRoot = createConsumer(root);
        const selection = { requestedPresets: ['quality-gate'], requestedAssets: [] };
        cliFetch({ projectRoot, manifestPath: release.manifestPath, sourceRoot: repositoryRoot, ...selection });
        const options = { projectRoot, sourceRevision, ...selection };
        const plan = cliPlan(options);
        cliApply({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest });
        const priorRevision = 'b'.repeat(40);
        const lockPath = path.join(projectRoot, '.ci/ci-assets.lock.json');
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.writeFileSync(lockPath, JSON.stringify({ schemaVersion: '1', kind: 'ci-github-asset-lock', sourceRevision: priorRevision,
          assets: plan.actions.map((entry) => ({ path: entry.destination, appliedSha256: entry.generatedSha256 })) }));
        expect(() => cliPlan(options)).toThrow(/^distribution-local-manifest-missing$/);
        const priorRoot = path.join(projectRoot, '.a3-skills/ci-github/distributions', priorRevision);
        fs.mkdirSync(priorRoot);
        fs.writeFileSync(path.join(priorRoot, 'manifest.json'), JSON.stringify({ schemaVersion: '1', kind: release.manifest.kind }));
        fs.writeFileSync(path.join(priorRoot, 'receipt.json'), '{}');
        expect(() => cliPlan(options)).toThrow(/^distribution-manifest-contract-unsupported$/);
      });
    });
  });
  describe('workflow-template-generation', () => {
    test('normal generation and application need no Hosted evidence and preserve ownership checks', async () => {
      // Arrange
      await withFixture('distribution-template-generation-', async (root) => {
        const release = prepareRelease(root);
        const projectRoot = createConsumer(root);
        cliFetch({ projectRoot, manifestPath: release.manifestPath, requestedPresets: ['quality-gate'], sourceRoot: repositoryRoot });
        const options = { projectRoot, sourceRevision, requestedPresets: ['quality-gate'], requestedAssets: [] };
        // Act / Assert
        const workflowPath = path.join(projectRoot, '.github/workflows/quality-gate.yml');
        fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
        fs.copyFileSync(path.join(repositoryRoot, 'workflows/quality/quality-gate.yml'), workflowPath);
        const independentBytes = fs.readFileSync(workflowPath);
        const unmanaged = cliPlan(options);
        expect(fs.readFileSync(workflowPath)).toEqual(independentBytes);
        expect(unmanaged.actions.map((entry) => entry.action)).toEqual(['conflict']);
        expect(() => cliApply({ projectRoot, planPath: unmanaged.planPath, approvalDigest: unmanaged.planDigest })).toThrow(/^distribution-plan-has-conflicts$/);
        expect(fs.readFileSync(workflowPath, 'utf8')).toContain('<quality-workflow-sha>');
        fs.rmSync(workflowPath);
        const plan = cliPlan(options);
        expect(plan.actions.every((entry) => entry.generatedSha256 !== entry.sourceSha256)).toBe(true);
        expect(plan.actions[0].generatedContent).toContain(`ci-quality.yml@${sourceRevision}`);
        expect(plan.actions[0].generatedContent).not.toMatch(/<[a-zA-Z][a-zA-Z0-9._-]*>/);
        const applied = cliApply({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest });
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
    // contract_id: contract.ci-selective-distribution.plan
    test('plan rejects unknown and mistyped caller settings and an owned caller with drifted structure', async () => {
      await withFixture('distribution-caller-settings-', async (root) => {
        const release = prepareRelease(root);
        const projectRoot = createConsumer(root);
        cliFetch({ projectRoot, manifestPath: release.manifestPath, requestedPresets: ['quality-gate'], sourceRoot: repositoryRoot });
        const options = { projectRoot, sourceRevision, requestedPresets: ['quality-gate'], requestedAssets: [] };
        const settings = fixturePlanSettings(options);
        const before = snapshotTree(projectRoot);
        const withSetting = (key, value) => ({ ...settings, 'workflow.quality-gate': { ...settings['workflow.quality-gate'], [key]: value } });
        expect(() => cliPlan({ ...options, settings: withSetting('unknown-setting', 'x') })).toThrow(/^workflow-template-setting-unknown$/);
        expect(() => cliPlan({ ...options, settings: withSetting('protected-branch', { branch: 'main' }) })).toThrow(/^workflow-template-setting-invalid$/);
        expect(snapshotTree(projectRoot)).toStrictEqual(before);
        const plan = cliPlan(options);
        cliApply({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest });
        const workflowPath = '.github/workflows/quality-gate.yml';
        const workflow = path.join(projectRoot, workflowPath);
        const drifted = yaml.parse(fs.readFileSync(workflow, 'utf8'));
        drifted.jobs[Object.keys(drifted.jobs)[0]].permissions = 'write-all';
        const driftedBytes = yaml.stringify(drifted);
        fs.writeFileSync(workflow, driftedBytes);
        fs.mkdirSync(path.join(projectRoot, '.ci'), { recursive: true });
        fs.writeFileSync(path.join(projectRoot, '.ci/ci-assets.lock.json'), JSON.stringify({ schemaVersion: '1', kind: 'ci-github-asset-lock',
          sourceRevision, assets: [{ path: workflowPath, appliedSha256: sha256(Buffer.from(driftedBytes)) }] }));
        const ownedBefore = snapshotTree(projectRoot);
        expect(() => cliPlan({ ...options, settings: {} })).toThrow(/^workflow-template-structure-conflict$/);
        expect(snapshotTree(projectRoot)).toStrictEqual(ownedBefore);
      });
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
          const projectRoot = createConsumer(root);
          const existingFile = path.join(projectRoot, 'README.md');
          fs.writeFileSync(existingFile, 'consumer-owned documentation\n');
          const fetched = cliFetch({ projectRoot, manifestPath: release.manifestPath, requestedPresets: ['quality-gate'], sourceRoot: repositoryRoot });
          expect(fetched.action).toBe('fetched');
          expect(fs.existsSync(path.join(fetched.distributionRoot, 'runtime/preset/run-validate-ci-preset.mjs'))).toBeTruthy();
          expect(cliVerify({ projectRoot, sourceRevision }).status).toBe('verified');
          const plan = cliPlan({ projectRoot, sourceRevision, requestedPresets: ['quality-gate'], requestedAssets: [] });
          expect(plan.actions.map((entry) => entry.action)).toStrictEqual(['create']);
          const applied = cliApply({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest });
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
          const rolledBack = cliRollback({ projectRoot, transactionId: applied.transactionId });
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
          const applySelection = (selection) => {
            cliFetch({ projectRoot, manifestPath: release.manifestPath, sourceRoot: repositoryRoot, ...selection });
            const selectionPlan = cliPlan({ projectRoot, sourceRevision, ...selection });
            return cliApply({ projectRoot, planPath: selectionPlan.planPath, approvalDigest: selectionPlan.planDigest });
          };
          const optionalApplied = applySelection({
            requestedPresets: ['quality-gate'], requestedAssets: ['workflow.quality-gate-platforms', 'runtime.quality-platforms-workflow'],
          });
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
          expect(cliRollback({ projectRoot, transactionId: optionalApplied.transactionId }).status).toBe('rolled-back');
          expect(ordinaryFiles(projectRoot).sort()).toStrictEqual(['.ci/platform-manifest.yml', '.ci/quality-platforms.yml', 'README.md']);
          const profilesApplied = applySelection({ requestedPresets: ['quality-gate-profiles'], requestedAssets: [] });
          expect(ordinaryFiles(projectRoot).sort()).toStrictEqual([
            '.ci/platform-manifest.yml', '.ci/quality-platforms.yml', '.github/workflows/quality-gate-profiles.yml', 'README.md',
          ]);
          const profilesWorkflow = yaml.parse(fs.readFileSync(path.join(projectRoot, '.github/workflows/quality-gate-profiles.yml'), 'utf8'));
          expect(profilesWorkflow.jobs.quality.uses).toBe(`a3-suite/a3-ci-github/.github/workflows/ci-quality.yml@${sourceRevision}`);
          expect(profilesWorkflow.jobs.quality.strategy.matrix.include.map((entry) => entry['language-profile'])).toStrictEqual(['rust', 'python']);
          expect(profilesWorkflow.jobs['profiles-summary'].name).toBe('quality-gate-profiles / summary');
          expect(cliRollback({ projectRoot, transactionId: profilesApplied.transactionId }).status).toBe('rolled-back');
          expect(ordinaryFiles(projectRoot).sort()).toStrictEqual(['.ci/platform-manifest.yml', '.ci/quality-platforms.yml', 'README.md']);
          const releaseApplied = applySelection({ requestedPresets: ['release-request', 'release-publication'], requestedAssets: [] });
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
          expect(cliRollback({ projectRoot, transactionId: releaseApplied.transactionId }).status).toBe('rolled-back');
          expect(ordinaryFiles(projectRoot).sort()).toStrictEqual(['.ci/platform-manifest.yml', '.ci/quality-platforms.yml', 'README.md']);
          const packageApplied = applySelection({ requestedPresets: ['package-publication'], requestedAssets: [] });
          expect(ordinaryFiles(projectRoot).sort()).toStrictEqual([
            '.ci/platform-manifest.yml', '.ci/provider-action-pins.yml', '.ci/quality-platforms.yml',
            '.github/workflows/package-publication-caller.yml', '.github/workflows/package-publication-request.yml', 'README.md',
          ]);
          expect(fs.existsSync(path.join(projectRoot, '.github/workflows/package-publication.yml'))).toBe(false);
          expect(fs.existsSync(path.join(projectRoot, '.github/workflows/package-preparation.yml'))).toBe(false);
          const packageCaller = fs.readFileSync(path.join(projectRoot, '.github/workflows/package-publication-caller.yml'), 'utf8');
          expect(packageCaller).toContain(`ci-package-publication.yml@${sourceRevision}`);
          expect(fs.readFileSync(existingFile, 'utf8')).toBe('consumer-owned documentation\n');
          expect(cliRollback({ projectRoot, transactionId: packageApplied.transactionId }).status).toBe('rolled-back');
          expect(ordinaryFiles(projectRoot).sort()).toStrictEqual(['.ci/platform-manifest.yml', '.ci/quality-platforms.yml', 'README.md']);
      });
    });

    // contract_id: contract.ci-selective-distribution.application
    test('plan rejects unmanaged destination drift and apply rejects changed plan inputs', async () => {
      await withFixture('a3-ci-github-distribution-conflict-', async (root) => {
          const release = prepareRelease(root);
          const projectRoot = createConsumer(root);
          fs.mkdirSync(path.join(projectRoot, '.github/workflows'), { recursive: true });
          cliFetch({ projectRoot, manifestPath: release.manifestPath, requestedPresets: ['quality-gate'], sourceRoot: repositoryRoot });
          const options = { projectRoot, sourceRevision, requestedPresets: ['quality-gate'], requestedAssets: [] };
          const workflow = path.join(projectRoot, '.github/workflows/quality-gate.yml');
          fs.writeFileSync(workflow, 'name: consumer-owned\n');
          const conflict = cliPlan(options);
          expect(conflict.actions.map((entry) => entry.action)).toStrictEqual(['conflict']);
          expect(() => cliApply({ projectRoot, planPath: conflict.planPath, approvalDigest: conflict.planDigest })).toThrow(/^distribution-plan-has-conflicts$/);
          fs.rmSync(workflow);
          const plan = cliPlan(options);
          fs.writeFileSync(workflow, 'name: changed-after-plan\n');
          expect(() => cliApply({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest })).toThrow(/^distribution-plan-input-changed$/);
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
        const projectRoot = createConsumer(root);
        const manifest = structuredClone(release.manifest);
        manifest.files['workflows/quality/quality-gate.yml'].sha256 = '0'.repeat(64);
        const failure = failureOf(() => cliFetch({
          projectRoot,
          manifestPath: writeManifest(root, manifest),
          requestedAssets: ['workflow.quality-gate', 'runtime.quality-workflow', 'runtime.preset', 'registry.ci-github', 'runtime.diagnostics'],
          sourceRoot: repositoryRoot,
        }));
        expect(failure.message).toBe('distribution-file-integrity-mismatch');
        expect(failure.evidence.comparison.field).toBe('workflows/quality/quality-gate.yml');
        expect(fs.existsSync(path.join(projectRoot, '.a3-skills/ci-github/distributions', sourceRevision))).toBe(false);
      });
    });

    // contract_id: contract.ci-selective-distribution.delivery
    test('fetch rejects a project-local state path redirected through a symlink', async () => {
      await withFixture('a3-ci-github-distribution-symlink-state-', async (root) => {
        const release = prepareRelease(root);
        const projectRoot = createConsumer(root);
        const externalRoot = path.join(root, 'external');
        fs.mkdirSync(externalRoot);
        fs.symlinkSync(externalRoot, path.join(projectRoot, '.a3-skills/ci-github/distributions'));
        expect(() => cliFetch({ projectRoot, manifestPath: release.manifestPath, requestedPresets: ['quality-gate'], sourceRoot: repositoryRoot }))
          .toThrow(/^distribution-local-root-outside-project$/);
        expect(fs.readdirSync(externalRoot)).toStrictEqual([]);
      });
    });

    // contract_id: contract.ci-selective-distribution.verification
    test('local verification rejects distribution bytes changed after fetch', async () => {
      await withFixture('a3-ci-github-distribution-local-integrity-', async (root) => {
        const release = prepareRelease(root);
        const projectRoot = createConsumer(root);
        const fetched = cliFetch({
          projectRoot,
          manifestPath: release.manifestPath,
          requestedAssets: ['workflow.quality-gate', 'runtime.quality-workflow', 'runtime.preset', 'registry.ci-github', 'runtime.diagnostics'],
          sourceRoot: repositoryRoot,
        });
        expect(cliVerify({ projectRoot, sourceRevision }).status).toBe('verified');
        fs.writeFileSync(path.join(fetched.distributionRoot, 'workflows/quality/quality-gate.yml'), 'tampered\n');
        expect(() => cliVerify({ projectRoot, sourceRevision })).toThrow(/^distribution-local-file-integrity-mismatch$/);
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
        const projectRoot = createConsumer(root);
        const directAssets = ['workflow.quality-gate', 'runtime.quality-workflow', 'runtime.preset', 'registry.ci-github', 'runtime.diagnostics'];
        const fetchSelection = (requestedPresets, requestedAssets) => cliFetch({ projectRoot, manifestPath: release.manifestPath,
          requestedPresets, requestedAssets, sourceRoot: repositoryRoot });
        fetchSelection([], directAssets);
        expect(() => cliPlan({ projectRoot, sourceRevision, requestedPresets: [], requestedAssets: directAssets }))
          .toThrow(/^distribution-copy-requires-matching-preset$/);
        fetchSelection(['release-request'], []);
        expect(() => cliPlan({ projectRoot, sourceRevision, requestedPresets: ['release-request'], requestedAssets: directAssets }))
          .toThrow(/^distribution-copy-requires-matching-preset$/);
        const optionalAssets = ['workflow.quality-gate-platforms', 'runtime.quality-platforms-workflow'];
        fetchSelection(['quality-gate'], optionalAssets);
        const optionalPlan = cliPlan({ projectRoot, sourceRevision, requestedPresets: ['quality-gate'], requestedAssets: optionalAssets });
        expect(optionalPlan.actions.some((entry) => entry.assetId === 'workflow.quality-gate-platforms')).toBeTruthy();
      });
    });

    // contract_id: contract.ci-selective-distribution.application
    test('apply rechecks destination ancestry immediately before writing', async () => {
      await withFixture('a3-ci-github-distribution-apply-symlink-', async (root) => {
        const release = prepareRelease(root);
        const projectRoot = createConsumer(root);
        const externalRoot = path.join(root, 'external');
        fs.mkdirSync(externalRoot);
        cliFetch({ projectRoot, manifestPath: release.manifestPath, requestedPresets: ['quality-gate'], sourceRoot: repositoryRoot });
        const plan = cliPlan({ projectRoot, sourceRevision, requestedPresets: ['quality-gate'], requestedAssets: [] });
        expect(() => cliApply({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest, faults: { transactionHooks: [{
          status: 'applying', index: 0, replaceDirectoryWithSymlink: { directory: path.join(projectRoot, '.github'), target: externalRoot } }] } }))
          .toThrow(/^distribution-destination-outside-root$/);
        expect(fs.readdirSync(externalRoot)).toStrictEqual([]);
      });
    });

    // contract_id: contract.ci-selective-distribution.application
    test('partial apply failure restores files changed earlier in the transaction', async () => {
      await withFixture('a3-ci-github-distribution-partial-', async (root) => {
        const release = prepareRelease(root);
        const projectRoot = createConsumer(root);
        cliFetch({ projectRoot, manifestPath: release.manifestPath, requestedPresets: ['release-publication'], sourceRoot: repositoryRoot });
        const plan = cliPlan({ projectRoot, sourceRevision, requestedPresets: ['release-publication'], requestedAssets: [] });
        expect(plan.actions.length > 1).toBeTruthy();
        const changedPath = path.join(projectRoot, plan.actions[1].destination);
        const retainedLock = path.join(projectRoot, '.a3-skills/ci-github/apply.lock');
        const failure = failureOf(() => cliApply({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest, faults: {
          failRemove: [{ path: retainedLock }],
          transactionHooks: [{ status: 'applying', index: 1, write: { path: changedPath, content: 'changed-after-plan\n' } }],
        } }));
        expect(failure.message).toBe('distribution-plan-input-changed');
        expect(failure.evidence['execution-state']).toMatchObject({ cleanup: 'lock-cleanup-failed', rollback: 'restored' });
        expect(fs.existsSync(retainedLock)).toBe(true);
        fs.rmSync(retainedLock, { force: true });
        expect(fs.existsSync(path.join(projectRoot, plan.actions[0].destination))).toBe(false);
        expect(fs.readFileSync(changedPath, 'utf8')).toBe('changed-after-plan\n');
        const transactionsRoot = path.join(projectRoot, '.a3-skills/ci-github/transactions');
        const transactionDirectories = fs.readdirSync(transactionsRoot);
        expect(transactionDirectories.length).toBe(1);
        const transactionPath = path.join(transactionsRoot, transactionDirectories[0], 'transaction.json');
        const transaction = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
        expect(transaction.status).toBe('rolled-back');
        expect(transaction.actions[0].state).toBe('restored');
        expect(transaction.actions[1].state).toBe('not-applied');
        transaction.status = 'rollback-required';
        fs.writeFileSync(transactionPath, `${JSON.stringify(transaction, null, 2)}\n`);
        expect(cliRollback({ projectRoot, transactionId: transaction.transactionId }).status).toBe('rolled-back');
        expect(fs.readFileSync(changedPath, 'utf8')).toBe('changed-after-plan\n');
      });
    });

    // contract_id: contract.ci-selective-distribution.application
    test('application rejects invalid ownership approval and concurrent mutation locks', async () => {
      await withFixture('a3-ci-github-distribution-application-guards-', async (root) => {
        const release = prepareRelease(root);
        const projectRoot = createConsumer(root);
        cliFetch({ projectRoot, manifestPath: release.manifestPath, requestedPresets: ['quality-gate'], sourceRoot: repositoryRoot });
        const options = { projectRoot, sourceRevision, requestedPresets: ['quality-gate'], requestedAssets: [] };
        const assetLockPath = path.join(projectRoot, '.ci/ci-assets.lock.json');
        fs.mkdirSync(path.dirname(assetLockPath), { recursive: true });
        fs.writeFileSync(assetLockPath, '{"schemaVersion":"1","kind":"invalid","assets":[]}\n');
        expect(() => cliPlan(options)).toThrow(/^distribution-prior-asset-lock-invalid$/);
        fs.rmSync(assetLockPath);
        const plan = cliPlan(options);
        const apply = () => cliApply({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest });
        expect(() => cliApply({ projectRoot, planPath: plan.planPath, approvalDigest: '0'.repeat(64) })).toThrow(/^distribution-plan-approval-invalid$/);
        fs.mkdirSync(path.dirname(assetLockPath), { recursive: true });
        fs.writeFileSync(assetLockPath, '{}\n');
        expect(apply).toThrow(/^distribution-plan-ownership-changed$/);
        fs.rmSync(assetLockPath);
        const mutationLock = path.join(projectRoot, '.a3-skills/ci-github/apply.lock');
        const transactionsPath = path.join(projectRoot, '.a3-skills/ci-github/transactions');
        const externalTransactions = path.join(root, 'external-transactions');
        fs.rmSync(transactionsPath, { recursive: true, force: true });
        fs.mkdirSync(externalTransactions);
        fs.symlinkSync(externalTransactions, transactionsPath);
        expect(apply).toThrow(/^distribution-transaction-root-outside-project$/);
        expect(fs.existsSync(mutationLock)).toBe(false);
        fs.rmSync(transactionsPath);
        fs.writeFileSync(mutationLock, 'occupied\n');
        expect(apply).toThrow(/^distribution-apply-locked$/);
        fs.rmSync(mutationLock);
        const applied = apply();
        fs.writeFileSync(mutationLock, 'occupied\n');
        expect(() => cliRollback({ projectRoot, transactionId: applied.transactionId })).toThrow(/^distribution-apply-locked$/);
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
        const projectRoot = createConsumer(root);
        cliFetch({ projectRoot, manifestPath: release.manifestPath, requestedPresets: ['quality-gate'], sourceRoot: repositoryRoot });
        const plan = cliPlan({ projectRoot, sourceRevision, requestedPresets: ['quality-gate'], requestedAssets: [] });
        const applied = cliApply({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest });
        const workflow = path.join(projectRoot, '.github/workflows/quality-gate.yml');
        fs.writeFileSync(workflow, 'name: edited-after-apply\n');
        expect(() => cliRollback({ projectRoot, transactionId: applied.transactionId })).toThrow(/^distribution-rollback-destination-changed$/);
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
          // The change lands after rollback has validated its inputs and recorded that it is restoring.
          const change = scenario === 'consumer-edit' ? { write: { path: workflow, content: 'consumer edit\n' } }
            : scenario === 'backup-tamper' ? { write: { path: backup, content: 'tampered backup\n' } }
              : { replaceDirectoryWithSymlink: { directory: path.dirname(workflow), target: externalRoot } };
          const diagnostic = scenario === 'consumer-edit' ? /^distribution-rollback-destination-changed$/
            : scenario === 'backup-tamper' ? /^distribution-backup-integrity-mismatch$/
              : /^distribution-destination-outside-root$/;
          expect(() => cliRollback({ projectRoot, transactionId, faults: { transactionHooks: [{ status: 'rolling-back', ...change }] } }), scenario)
            .toThrow(diagnostic);
          if (scenario === 'destination-symlink') expect(fs.lstatSync(path.dirname(workflow)).isSymbolicLink()).toBe(true);
          if (scenario === 'backup-tamper') expect(fs.readFileSync(backup, 'utf8')).toBe('tampered backup\n');
          expect(fs.readFileSync(workflow, 'utf8'), scenario).toBe(scenario === 'consumer-edit' ? 'consumer edit\n' : 'applied\n');
          expect(fs.readFileSync(path.join(externalRoot, 'quality-gate.yml'), 'utf8'), scenario).toBe('applied\n');
          expect(JSON.parse(fs.readFileSync(transactionPath, 'utf8')).status, scenario).toBe('rollback-required');
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
          const projectRoot = createConsumer(root, problem);
          const options = { projectRoot, manifestPath: release.manifestPath, requestedPresets: ['release-request'] };
          const fetched = cliFetch({ ...options, sourceRoot: committedSourceRoot });
          let diagnostic;
          if (problem === 'bytes') {
            fs.appendFileSync(path.join(fetched.distributionRoot, fetched.files[0]), 'tampered');
            diagnostic = 'distribution-local-file-integrity-mismatch';
          } else if (problem === 'receipt') {
            const receiptPath = path.join(fetched.distributionRoot, 'receipt.json');
            const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
            receipt.manifestSha256 = '0'.repeat(64);
            fs.writeFileSync(receiptPath, JSON.stringify(receipt));
            diagnostic = 'distribution-local-receipt-invalid';
          } else if (problem === 'manifest') {
            options.manifestPath = path.join(root, 'changed-manifest.json');
            fs.writeFileSync(options.manifestPath, Buffer.concat([release.manifestBytes, Buffer.from('\n')]));
            diagnostic = 'distribution-existing-root-conflict';
          } else {
            fs.writeFileSync(path.join(fetched.distributionRoot, '.fetch.lock'), 'another fetch owns this lock');
            diagnostic = 'distribution-fetch-locked';
          }
          const before = snapshotTree(projectRoot);
          const log = path.join(root, `${problem}-transport.log`);

          // Act / Assert
          expect(() => cliFetch({ ...options, faults: { transport: { log, failure: 'transport must not be called' } } }), problem)
            .toThrow(new RegExp(`^${diagnostic}$`));
          expect(fs.existsSync(log), problem).toBe(false);
          expect(snapshotTree(projectRoot), problem).toEqual(before);
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
        const projectRoot = createConsumer(root);
        const fetched = cliFetch({ projectRoot, manifestPath: release.manifestPath, requestedPresets: ['release-request'],
          sourceRoot: committedSourceRoot });
        const before = snapshotTree(projectRoot);
        const transport = { sourceRoot: committedSourceRoot, sourceRevision };
        const options = { projectRoot, manifestPath: release.manifestPath, requestedPresets: ['quality-gate'] };

        const lockPath = path.join(fetched.distributionRoot, '.fetch.lock');
        const report = path.join(root, 'probe.jsonl');
        const peerLog = path.join(root, 'peer-transport.log');
        const peer = { call: 1, ...cliFetchPeer({ ...options, faults: { transport: { log: peerLog, failure: 'peer transport must not be called' } } }) };

        // Act / Assert
        const failure = failureOf(() => cliFetch({ ...options, faults: { transport: { ...transport, failFromCall: 2, probe: { lockPath, report, peer } } } }));
        expect(failure.message).toBe('distribution-download-failed');
        const probes = fs.readFileSync(report, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        // The failing extension download is retried by the CLI, so every attempt after the first call must still hold the lock.
        expect(probes.length).toBeGreaterThan(1);
        expect(probes.every(({ lockPresent }) => lockPresent)).toBe(true);
        expect(probes[0].peer.status).toBe(2);
        expect(JSON.parse(probes[0].peer.stderr).diagnostic).toBe('distribution-fetch-locked');
        expect(fs.existsSync(peerLog)).toBe(false);
        expect(snapshotTree(projectRoot)).toEqual(before);
        expect(fs.existsSync(path.join(fetched.distributionRoot, '.fetch.lock'))).toBe(false);
        expect(cliVerify({ projectRoot, sourceRevision }).status).toBe('verified');
        const recovered = cliFetch({ ...options, faults: { transport } });
        expect(recovered.action).toBe('merged');
        expect(cliVerify({ projectRoot, sourceRevision }).status).toBe('verified');
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
          const projectRoot = createConsumer(root, operation);
          const options = { projectRoot, manifestPath: release.manifestPath, requestedPresets: ['release-request'] };
          const fetched = cliFetch({ ...options, sourceRoot: committedSourceRoot });
          const lockPath = path.join(fetched.distributionRoot, '.fetch.lock');
          const stateRoot = path.join(projectRoot, '.a3-skills/ci-github');
          const log = path.join(root, `${operation}-transport.log`);
          const faults = { transport: { log, failure: 'transport must not be called' },
            ...(operation === 'close' ? { failClose: [{ path: lockPath }] } : { failRemove: [{ path: lockPath }] }) };

          // Act / Assert
          const failure = failureOf(() => cliFetch({ ...options, faults }));
          expect(failure.message, operation).toBe('distribution-lock-cleanup-failed');
          expect(failure.evidence['execution-state'].cleanupFailures, operation).toEqual([operation === 'close' ? 'lock-close' : 'lock-remove']);
          expect(fs.existsSync(log), operation).toBe(false);
          expect(fs.readdirSync(stateRoot).filter((name) => name.startsWith('.staging-')), operation).toEqual([]);
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
          const projectRoot = createConsumer(root, operation);
          const options = { projectRoot, manifestPath: release.manifestPath, requestedPresets: ['release-request'] };
          const fetched = cliFetch({ ...options, sourceRoot: committedSourceRoot });
          const before = snapshotTree(fetched.distributionRoot);
          const failRemove = [
            ...(operation !== 'staging' ? [{ path: path.join(fetched.distributionRoot, '.fetch.lock') }] : []),
            ...(operation !== 'lock' ? [{ pattern: '[\\\\/]\\.staging-[^\\\\/]+$' }] : []),
          ];
          const failure = failureOf(() => cliFetch({ ...options, requestedPresets: ['quality-gate'],
            faults: { failRemove, transport: { body: 'corrupt' } } }));
          expect(failure.message, operation).toBe('distribution-file-integrity-mismatch');
          expect(failure.evidence['execution-state'].write, operation).toBe('not-started');
          expect(failure.evidence['execution-state'].cleanupFailures, operation).toEqual(operation === 'lock' ? ['lock-remove']
            : operation === 'staging' ? ['staging-remove'] : ['lock-remove', 'staging-remove']);
          const after = snapshotTree(fetched.distributionRoot);
          delete after['.fetch.lock'];
          expect(after, operation).toEqual(before);
          expect(cliVerify({ projectRoot, sourceRevision }).status, operation).toBe('verified');
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
        const projectRoot = createConsumer(root);
        const options = { projectRoot, manifestPath: release.manifestPath, requestedPresets: ['release-request'] };
        const fetched = cliFetch({ ...options, sourceRoot: committedSourceRoot });
        const sourceRoot = path.join(root, 'invalid-source');
        const invalidFile = path.join(sourceRoot, fetched.files[0]);
        fs.mkdirSync(path.dirname(invalidFile), { recursive: true });
        fs.writeFileSync(invalidFile, 'invalid explicit source bytes');
        const before = snapshotTree(projectRoot);
        const log = path.join(root, 'transport.log');

        // Act / Assert
        expect(() => cliFetch({ ...options, sourceRoot, faults: { transport: { log, failure: 'transport must not be called' } } }))
          .toThrow(/^distribution-file-integrity-mismatch$/);
        expect(fs.existsSync(log)).toBe(false);
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
        const projectRoot = createConsumer(root);
        fs.writeFileSync(path.join(projectRoot, 'README.md'), 'project-owned content');
        const before = snapshotTree(projectRoot);
        const cases = [
          ['missing Location', { status: 302 }, 'distribution-download-redirect-location-missing'],
          ['untrusted redirect', { status: 302, location: 'https://example.invalid/asset' }, 'distribution-download-redirect-untrusted'],
          ['insecure redirect', { status: 302, location: 'http://raw.githubusercontent.com/asset' }, 'distribution-download-redirect-untrusted'],
          ['HTTP failure', { status: 404 }, 'http-404'],
          ['opaque transport failure', { failure: 'transport unavailable' }, 'network-result-unknown'],
        ];
        for (const [index, [label, response, observed]] of cases.entries()) {
          const log = path.join(root, `transport-${index}.log`);
          // Act / Assert
          const failure = failureOf(() => cliFetch({ projectRoot, manifestPath: release.manifestPath, requestedPresets: ['quality-gate'],
            faults: { transport: { log, ...response } } }));
          expect(failure.message, label).toBe('distribution-download-failed');
          expect(failure.evidence.comparison.observed, label).toBe(observed);
          const requests = fs.readFileSync(log, 'utf8').trim().split('\n');
          expect(requests.length > 0, label).toBeTruthy();
          expect(requests.every((url) => url.startsWith(`${release.manifest.rawOrigin}/${release.manifest.repository}/${sourceRevision}/`)), label).toBeTruthy();
          expect(snapshotTree(projectRoot), label).toStrictEqual(before);
        }
      });
    });
  });
});


describe("contract.ci-selective-distribution.application", () => {
  describe("selective-distribution-application", () => {
    // evidence_role: contract
    // test_level: integration
    // contract_id: contract.ci-selective-distribution.plan
    // integration_id: selective-distribution-application
    test('plan rejects malformed prior ownership locks before changing consumer state', async () => {
      // Arrange
      await withFixture('distribution-prior-lock-', async (root) => {
        const release = prepareRelease(root);
        const projectRoot = createConsumer(root);
        cliFetch({ projectRoot, manifestPath: release.manifestPath, requestedPresets: ['quality-gate'], sourceRoot: repositoryRoot });
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
          expect(() => cliPlan({ projectRoot, sourceRevision, requestedPresets: ['quality-gate'], requestedAssets: [] }), label)
            .toThrow(/^distribution-prior-asset-lock-invalid$/);
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
        const projectRoot = createConsumer(root);
        const projectDocument = path.join(projectRoot, 'README.md');
        fs.writeFileSync(projectDocument, 'project-owned content');
        cliFetch({ projectRoot, manifestPath: release.manifestPath, requestedPresets: ['quality-gate'], sourceRoot: repositoryRoot });
        const options = { projectRoot, sourceRevision, requestedPresets: ['quality-gate'], requestedAssets: [] };
        const initial = cliPlan(options);
        cliApply({ projectRoot, planPath: initial.planPath, approvalDigest: initial.planDigest });
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
        const reuse = cliPlan(options);
        // Act
        const reused = cliApply({ projectRoot, planPath: reuse.planPath, approvalDigest: reuse.planDigest });
        // Assert
        expect(reuse.actions.map((entry) => entry.action)).toStrictEqual(['reuse']);
        expect(fs.readFileSync(workflow)).toStrictEqual(canonical);
        const reusedTransaction = path.join(projectRoot, '.a3-skills/ci-github/transactions', reused.transactionId);
        expect(JSON.parse(fs.readFileSync(path.join(reusedTransaction, 'transaction.json'), 'utf8')).actions).toStrictEqual([]);
        cliRollback({ projectRoot, transactionId: reused.transactionId });
        expect(fs.readFileSync(workflow)).toStrictEqual(canonical);
        // Arrange
        const oldManagedBytes = Buffer.from(canonical.toString('utf8').replaceAll('ubuntu-24.04', 'ubuntu-22.04'));
        fs.writeFileSync(workflow, oldManagedBytes);
        writeOwnership(oldManagedBytes);
        const ownershipBefore = fs.readFileSync(lockPath);
        const preserved = cliPlan({ ...options, settings: {} });
        expect(preserved.actions.map((entry) => entry.action)).toEqual(['reuse']);
        expect(preserved.actions[0].generatedContent).toBe(oldManagedBytes.toString('utf8'));
        const update = cliPlan(options);
        // Act
        const updated = cliApply({ projectRoot, planPath: update.planPath, approvalDigest: update.planDigest });
        // Assert
        expect(update.actions.map((entry) => entry.action)).toStrictEqual(['update']);
        expect(fs.readFileSync(workflow)).toStrictEqual(canonical);
        const transactionRoot = path.join(projectRoot, '.a3-skills/ci-github/transactions', updated.transactionId);
        expect(fs.readFileSync(path.join(transactionRoot, 'before', workflowPath))).toStrictEqual(oldManagedBytes);
        expect(fs.readFileSync(lockPath)).toStrictEqual(ownershipBefore);
        // Act
        const rolledBack = cliRollback({ projectRoot, transactionId: updated.transactionId });
        // Assert
        expect(rolledBack.rollbackStatus).toBe('restored');
        expect(fs.readFileSync(workflow)).toStrictEqual(oldManagedBytes);
        expect(fs.readFileSync(lockPath)).toStrictEqual(ownershipBefore);
        expect(fs.readFileSync(projectDocument, 'utf8')).toBe('project-owned content');
        // Arrange
        fs.writeFileSync(workflow, 'unmanaged project edit');
        const conflict = cliPlan(options);
        const before = snapshotTree(projectRoot);
        // Act / Assert
        expect(conflict.actions.map((entry) => entry.action)).toStrictEqual(['conflict']);
        expect(() => cliApply({ projectRoot, planPath: conflict.planPath,
          approvalDigest: conflict.planDigest })).toThrow(/^distribution-plan-has-conflicts$/);
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
        expect(() => cliRollback({ projectRoot, transactionId })).toThrow(/^distribution-transaction-missing$/);
        const lock = path.join(stateRoot, 'apply.lock');
        const failure = failureOf(() => cliRollback({ projectRoot, transactionId, faults: { failRemove: [{ path: lock }] } }));
        expect(failure.message).toBe('distribution-transaction-missing');
        expect(failure.evidence['evidence-location'].transaction).toBe(transactionId);
        expect(failure.evidence['execution-state']).toMatchObject({ write: 'not-started', rollback: 'unavailable',
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
          const projectRoot = createConsumer(root, operation);
          cliFetch({ projectRoot, manifestPath: release.manifestPath, requestedPresets: ['release-request'], sourceRoot: committedSourceRoot });
          const plan = cliPlan({ projectRoot, sourceRevision, requestedPresets: ['release-request'], requestedAssets: [] });
          const lock = path.join(projectRoot, '.a3-skills/ci-github/apply.lock');
          const faults = { failRemove: [{ path: lock }] };
          const apply = (options) => cliApply({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest, ...options });
          const applied = operation === 'rollback' ? apply() : undefined;
          const failure = failureOf(() => (operation === 'apply' ? apply({ faults })
            : cliRollback({ projectRoot, transactionId: applied.transactionId, faults })));
          expect(failure.message, operation).toBe('distribution-lock-cleanup-failed');
          expect(failure.evidence['execution-state'].write, operation).toBe(operation === 'apply' ? 'applied' : 'rolled-back');
          expect(failure.evidence['execution-state'].rollback, operation).toBe(operation === 'apply' ? 'not-required' : 'restored');
          const transactionId = failure.evidence['evidence-location'].transaction;
          expect(transactionId, operation).toMatch(/^[0-9]+-[0-9a-f]{12}$/);
          const transaction = JSON.parse(fs.readFileSync(path.join(projectRoot,
            '.a3-skills/ci-github/transactions', transactionId, 'transaction.json'), 'utf8'));
          expect(transaction.status, operation).toBe(operation === 'apply' ? 'applied' : 'rolled-back');
          for (const entry of plan.actions) {
            const target = path.join(projectRoot, entry.destination);
            if (operation === 'apply') expect(fs.readFileSync(target, 'utf8')).toBe(entry.generatedContent);
            else expect(fs.existsSync(target)).toBe(false);
          }
          expect(fs.existsSync(lock), operation).toBe(true);
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
        const projectRoot = createConsumer(root);
        cliFetch({ projectRoot, manifestPath: release.manifestPath, requestedPresets: ['release-request'], sourceRoot: committedSourceRoot });
        const plan = cliPlan({ projectRoot, sourceRevision, requestedPresets: ['release-request'], requestedAssets: [] });
        const applied = cliApply({ projectRoot, planPath: plan.planPath, approvalDigest: plan.planDigest });
        const transactionPath = path.join(projectRoot, '.a3-skills/ci-github/transactions', applied.transactionId, 'transaction.json');
        const target = path.join(projectRoot, plan.actions.at(-1).destination);
        const before = fs.readFileSync(target);
        const lockPath = path.join(projectRoot, '.a3-skills/ci-github/apply.lock');
        for (const lockCleanupFails of [false, true]) {
          const failure = failureOf(() => cliRollback({ projectRoot, transactionId: applied.transactionId, faults: {
            failRemove: [{ path: target }, ...(lockCleanupFails ? [{ path: lockPath }] : [])],
            failRenameAfterRemoveFailure: [{ path: transactionPath }],
          } }));
          expect(failure.message).toBe('distribution-unknown-failure');
          expect(failure.evidence['evidence-location'].transaction).toBe(applied.transactionId);
          expect(failure.evidence['execution-state']).toMatchObject({ write: 'partial-output', rollback: 'failed',
            cleanup: lockCleanupFails ? 'lock-cleanup-failed' : 'transaction-record-write-failed' });
          if (lockCleanupFails) expect(failure.evidence['execution-state'].cleanupFailures).toEqual(['lock-remove']);
          expect(fs.readFileSync(target)).toEqual(before);
          expect(JSON.parse(fs.readFileSync(transactionPath, 'utf8')).status).toBe('rolling-back');
          expect(fs.existsSync(lockPath)).toBe(lockCleanupFails);
        }
      });
    });
  });
});
