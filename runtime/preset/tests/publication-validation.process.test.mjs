import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { parse } from 'yaml';
import { createReport } from '../validation-report.ts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { loadRegistry } from '../preset-registry.ts';
import { prepareBootstrapRuntime } from './support/release-request-fixture.mjs';
import { validateCiPresetCli } from './support/preset-cli.mjs';
import { describe, expect, test } from 'vitest';
import { supplementalOwnerAdapterEntrypoint, validateReleasePublicationFlow } from '../publication-validation.ts';
import { resolvePublicationWorkflow } from '../ci-preset-assets.ts';

const consumerReleasePreflight = (t) => {
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  fs.mkdirSync(path.join(repository, 'tmp'), { recursive: true });
  const root = fs.mkdtempSync(path.join(repository, 'tmp', 'consumer-release-'));
  t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  prepareBootstrapRuntime({ repositoryRoot: repository, runtimeRoot: path.join(repository, 'runtime/preset'), consumerRoot: root });
  const preset = loadRegistry(createReport()).presets.find(item => item.id === 'release-publication');
  const callerAsset = preset.workflowAssets.find(item => item.id === 'release-publication-caller');
  const requestAsset = preset.workflowAssets.find(item => item.id === 'release-publication-request');
  fs.mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
  return (mutate = () => {}) => {
    const caller = parse(fs.readFileSync(path.join(repository, callerAsset.source), 'utf8'));
    Object.assign(caller.jobs.publish.with, {
      runner: 'ubuntu-24.04', 'language-profile': 'rust', 'release-implementation': 'rust-cli-release',
      'standard-bundle-id': 'rust-cargo-quality', 'adapter-descriptor': '', 'platform-manifest': '.ci/platform-manifest.yml',
      supplemental_release_asset_enabled: false, supplemental_release_asset_owner_contract: '__unset__',
      supplemental_release_asset_implementation: 'owner-adapter', supplemental_release_asset_config_path: '__unset__', release_skills_config_path: '__unset__',
    });
    const request = parse(fs.readFileSync(path.join(repository, requestAsset.source), 'utf8'));
    mutate({ caller, request });
    fs.writeFileSync(path.join(root, callerAsset.destination), stringify(caller));
    fs.writeFileSync(path.join(root, requestAsset.destination), stringify(request));
    const result = spawnSync(process.execPath, [
      path.join(repository, 'runtime/preset/run-validate-ci-preset.mjs'),
      '--audit-mode', 'read-only', '--repo-root', root, '--preset', 'release-publication',
    ], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(1);
    return JSON.parse(result.stdout);
  };
};

describe("contract.ci-preset-assurance.verification", () => {
  describe("consumer-release-publication-drift", () => {
    // contract_id: contract.ci-preset-assurance.verification
    // flow_id: consumer-release-publication-drift
    test('public preflight fails when the consumer request omits the owner version or target input', (t) => {
      const finding = 'standard Release request must bind explicit owner version and target';
      // Arrange
      const preflight = consumerReleasePreflight(t);
      const baseline = preflight();
      for (const field of ['release_version', 'target_identity']) {
        // Act
        const report = preflight(({ request }) => { delete request.on.workflow_dispatch.inputs[field]; });
        // Assert
        expect(report.status).toBe('failed');
        expect(report.mismatches.some(item => item.message === finding && item.path.endsWith(`inputs.${field}`)), field).toBe(true);
      }
      expect(baseline.mismatches.some(item => item.message === finding)).toBe(false);
    });

    // contract_id: contract.ci-preset-assurance.verification
    // flow_id: consumer-release-publication-drift
    test('public preflight reports an owner-adapter supplemental selection that names an installer declaration', (t) => {
      const finding = 'supplemental implementation, enabled selection, owner contract and declaration path must agree';
      // Arrange
      const preflight = consumerReleasePreflight(t);
      const baseline = preflight();
      // Act
      const report = preflight(({ caller }) => { caller.jobs.publish.with.supplemental_release_asset_config_path = '.ci/installer/assembly.json'; });
      // Assert
      expect(report.status).toBe('failed');
      expect(report.mismatches.some(item => item.message === finding)).toBe(true);
      expect(baseline.mismatches.some(item => item.message === finding)).toBe(false);
    });
  });
});

describe("contract.ci-preset-assurance.verification", () => {
  describe("asset-release-publication-preset", () => {
    // contract_id: contract.ci-preset-assurance.verification
    // flow_id: asset-release-publication-preset
    test('asset release preset owns its caller, validates the asset callee and excludes the release preset', (t) => {
      // Arrange
      const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
      fs.mkdirSync(path.join(repository, 'tmp'), { recursive: true });
      const root = fs.mkdtempSync(path.join(repository, 'tmp', 'asset-release-'));
      t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
      const registry = loadRegistry(createReport());
      const preset = registry.presets.find(item => item.id === 'asset-release-publication');
      const callerAsset = preset.workflowAssets.find(item => item.id === 'asset-release-publication-caller');
      const requestAsset = preset.workflowAssets.find(item => item.id === 'release-publication-request');
      const caller = parse(fs.readFileSync(path.join(repository, callerAsset.source), 'utf8'));
      Object.assign(caller.jobs.publish.with, {
        runner: 'ubuntu-24.04', 'jq-version': '', 'language-profile': '', 'toolchain-version': '', 'uv-version': '', 'cargo-audit-version': '',
        'cargo-manifest-path': '', 'cargo-lock-path': '', 'cargo-deny-version': '', 'cargo-deny-config-path': '', 'standard-bundle-id': '', 'adapter-descriptor': '',
        supplemental_release_asset_enabled: true, supplemental_release_asset_owner_contract: 'owner.prompt-assets', release_skills_config_path: '.ci/release-skills.yml',
      });
      fs.mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
      fs.mkdirSync(path.join(root, '.ci/scripts'), { recursive: true });
      fs.writeFileSync(path.join(root, '.ci/scripts/ci-release-supplemental-asset.sh'), '#!/bin/sh\n', { mode: 0o755 });
      fs.copyFileSync(path.join(repository, requestAsset.source), path.join(root, requestAsset.destination));
      fs.writeFileSync(path.join(root, callerAsset.destination), stringify(caller));
      const execution = resolvePublicationWorkflow(caller, registry);
      const flow = (publication) => {
        const report = createReport();
        validateReleasePublicationFlow(new Map([
          [requestAsset.destination, parse(fs.readFileSync(path.join(root, requestAsset.destination), 'utf8'))],
          [callerAsset.destination, caller],
          ['.github/workflows/asset-release-publication.yml', publication],
        ]), report);
        return report.mismatches;
      };
      // Act
      const detected = validateCiPresetCli({ repoRoot: root });
      const both = validateCiPresetCli({ repoRoot: root, presets: ['release-publication', 'asset-release-publication'] });
      // Assert
      expect(detected.inspectedPresets).toContain('asset-release-publication');
      expect(detected.inspectedPresets).not.toContain('release-publication');
      expect([...detected.mismatches, ...detected.missingSettings].filter(item => /asset-release-publication\.yml:|canonical drift|conditional extension/.test(`${item.path} ${item.message}`))).toStrictEqual([]);
      expect(detected.missingSettings.some(item => item.message.includes('publication reusable workflow is pending-release'))).toBe(true);
      expect(both.status).toBe('failed');
      expect(both.mismatches.some(item => item.path === callerAsset.destination && item.message === 'selected presets install different workflows at the same destination')).toBe(true);
      expect(detected.mismatches.some(item => item.message === 'selected presets install different workflows at the same destination')).toBe(false);
      expect(supplementalOwnerAdapterEntrypoint(execution)).toBe('.ci/scripts/ci-release-supplemental-asset.sh');
      expect(flow(execution)).toStrictEqual([]);
      for (const mutate of [
        value => { value.jobs.build = { 'runs-on': 'ubuntu-24.04', steps: [] }; },
        value => { delete value.jobs.quality.if; },
        value => { value.jobs.assemble.needs = ['authority', 'quality']; },
        value => { value.jobs.assemble.if = value.jobs.assemble.if.replace("needs.authority.result == 'success' &&", "needs.authority.result == 'success' ||"); },
        value => { value.jobs['supplemental-asset'].if = value.jobs['supplemental-asset'].if.replace("needs.authority.result == 'success' &&", "needs.authority.result == 'success' ||"); },
        value => { value.jobs.authority.steps.find(step => step.id === 'config').with['sources-json'] = value.jobs.authority.steps.find(step => step.id === 'config').with['sources-json'].replace('"CI_SUPPLEMENTAL_RELEASE_ASSET_IMPLEMENTATION":"owner-adapter"', '"CI_SUPPLEMENTAL_RELEASE_ASSET_IMPLEMENTATION":"standard-installer"'); },
      ]) {
        const changed = structuredClone(execution); mutate(changed);
        expect(flow(changed).length, String(mutate)).toBeGreaterThan(0);
      }
      const qualityFindings = (report) => [...report.mismatches, ...report.missingSettings].filter(item => /quality adapter|CI_UV_VERSION|standard bundle/.test(item.message));
      expect(qualityFindings(detected)).toStrictEqual([]);
      caller.jobs.publish.with['language-profile'] = 'python';
      fs.writeFileSync(path.join(root, callerAsset.destination), stringify(caller));
      const profiled = validateCiPresetCli({ repoRoot: root });
      expect(profiled.missingSettings.some(item => item.message === 'CI_UV_VERSION is required for the selected language profile')).toBe(true);
      expect(profiled.missingSettings.some(item => item.message === 'quality adapter descriptor is missing')).toBe(true);
      const release = parse(fs.readFileSync(path.join(repository, 'workflows/release/release-publication-caller.yml'), 'utf8'));
      fs.writeFileSync(path.join(root, callerAsset.destination), stringify(release));
      const switched = validateCiPresetCli({ repoRoot: root });
      expect(switched.inspectedPresets).toContain('release-publication');
      expect(switched.inspectedPresets).not.toContain('asset-release-publication');
    });
  });
});
