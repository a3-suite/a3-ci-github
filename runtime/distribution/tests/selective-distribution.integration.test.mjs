import fs from 'node:fs';
import path from 'node:path';
import { expect, test, describe } from 'vitest';
import { applyDistributionPlan, fetchDistribution, resolveDistributionSelection, rollbackDistributionTransaction, verifyFetchedDistribution } from '../fetch-a3-ci-github.mjs';
import { readWorkflowSettings, renderWorkflowTemplate } from '../../preset/workflow-template.mjs';
import { repositoryRoot, yaml, planDistributionApplication, committedSourceRoot, sourceRevision, sha256, withFixture, prepareRelease } from './selective-distribution.fixtures.mjs';


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


describe("contract.ci-selective-distribution.application", () => {
  describe('provider-pin-companion', () => {
    // contract_id: contract.ci-selective-distribution.application
    // integration_id: selective-distribution-application-direct
    // test_level: integration
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
});
  describe('workflow-template-generation', () => {
    // contract_id: contract.ci-selective-distribution.application
    // integration_id: selective-distribution-application-direct
    // test_level: integration
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
    // integration_id: selective-distribution-application-direct
    // test_level: integration
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
});


describe("contract.ci-selective-distribution.application", () => {
  describe("selective-distribution", () => {

    // contract_id: contract.ci-selective-distribution.application
    // integration_id: selective-distribution-application-direct
    // test_level: integration
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
  });
});


describe("contract.ci-selective-distribution.delivery", () => {
  describe("selective-distribution", () => {

    // contract_id: contract.ci-selective-distribution.delivery
    // integration_id: selective-distribution-delivery-direct
    // test_level: integration
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
    // evidence_role: supplemental
    // Reusing verified cached files is a delivery mechanism that no delivery guarantee covers.
    // test_level: integration
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
  });
});
