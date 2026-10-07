import fs from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
import { parse } from 'yaml';
import { supplementalOwnerAdapterEntrypoint, validateCaller, validateReleasePublicationFlow } from '../publication-validation.ts';
import { createReport } from '../validation-report.ts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { loadRegistry } from '../preset-registry.ts';
import { resolvePublicationWorkflow, inactiveConditionalEntrypoints } from '../ci-preset-assets.ts';
import { inspectWorkflowAsset } from '../workflow-validation.ts';
import { validateCiPresetInternal } from '../validate-ci-preset-core.ts';
import { validateConditionalExtensions, validateQualityPreset } from '../quality-validation.ts';
import { findWorkflowAssetReferences } from '../workflow-assets.ts';

const model = () => {
  const workflows = new Map(['release-publication-request', 'release-publication-caller'].map((id) => [
    `.github/workflows/${id}.yml`, parse(fs.readFileSync(new URL(`../../../workflows/release/${id}.yml`, import.meta.url), 'utf8')),
  ]));
  const selection = workflows.get('.github/workflows/release-publication-caller.yml').jobs.publish.with;
  expect(selection).toHaveProperty('supplemental_release_asset_implementation', '<supplemental-release-asset-implementation>');
  expect(selection).toHaveProperty('supplemental_release_asset_config_path', '<supplemental-release-asset-config-path>');
  selection.supplemental_release_asset_implementation = 'owner-adapter';
  selection.supplemental_release_asset_config_path = '__unset__';
  workflows.set('.github/workflows/release-publication.yml', resolvePublicationWorkflow(
    workflows.get('.github/workflows/release-publication-caller.yml'), loadRegistry(createReport())));
  return workflows;
};
const phase = (workflows, job) => workflows.get('.github/workflows/release-publication.yml').jobs[job].steps.find((step) => step.uses?.includes('/actions/ci-release-supplemental-asset@'));
const inspect = (workflows) => {
  const report = createReport();
  validateReleasePublicationFlow(workflows, report);
  return report;
};

describe("contract.ci-preset-assurance.verification", () => {
  describe("standard-release-publisher-footprint", () => {
    // contract_id: contract.ci-preset-assurance.verification
    // integration_id: standard-release-publisher-footprint
    test('standard Release workflow requires no local publisher and preflight rejects write binding drift', (t) => {
      const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
      const parent = path.join(repository, 'tmp');
      fs.mkdirSync(parent, { recursive: true });
      const root = fs.mkdtempSync(path.join(parent, 'publisher-consumer-'));
      t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
      const registry = loadRegistry(createReport());
      const preset = registry.presets.find(preset => preset.id === 'release-publication');
      const asset = { id: 'release-publication', source: '.github/workflows/ci-release-publication.yml', destination: '.github/workflows/release-publication.yml' };
      const filename = path.join(root, asset.destination);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      const workflow = parse(fs.readFileSync(path.join(repository, '.github/workflows/ci-release-publication.yml'), 'utf8'));
      workflow.env.CI_RELEASE_IMPLEMENTATION = 'rust-cli-release';
      workflow.env.CI_LANGUAGE_PROFILE = 'rust';
      const original = stringify(workflow);
      expect(findWorkflowAssetReferences(root, original).includes('.ci/trusted/ci-release-publish.sh')).toBe(false);
      const run = (value) => {
        fs.writeFileSync(filename, stringify(value));
        const report = createReport();
        inspectWorkflowAsset({ root, registry, parsed: new Map(), report,
          actionByPath: new Map(registry.actionTargets.map(target => [`${registry.actionRepository}/${target.actionPath}`, target])) }, preset, asset, new Set());
        return report;
      };
      expect(run(workflow).missingSettings.some(item => item.path === '.ci/trusted/ci-release-publish.sh')).toBe(false);
      expect(fs.existsSync(path.join(root, '.ci'))).toBe(false);
      expect(registry.standardImplementations.find(item => item.id === 'rust-cli-release').fulfillsExtensions['release-publication-adapter']).toBe('ci-release-publisher');
      for (const mutate of [
        step => { step.if = 'always()'; },
        step => { step.with['authority-path'] = 'other.json'; },
        step => { step.env.GH_TOKEN = '${{ secrets.OTHER }}'; },
        step => { step['continue-on-error'] = true; },
        step => { step.run = '.ci/trusted/ci-release-publish.sh'; delete step.uses; },
      ]) {
        const changed = parse(original);
        mutate(changed.jobs.publish.steps.find(step => step.id === 'publish'));
        expect(run(changed).mismatches.some(item => item.message.startsWith('canonical drift:') && item.path.includes('jobs.publish.steps'))).toBeTruthy();
      }
      const ownerFallback = parse(original);
      ownerFallback.jobs.publish.steps.push({ id: 'publish_owner', if: 'always()', shell: 'bash', run: '.ci/trusted/ci-release-publish.sh' });
      expect(run(ownerFallback).mismatches.some(item => item.message.startsWith('canonical drift:'))).toBeTruthy();
    });
  });
});

describe("contract.ci-preset-assurance.verification", () => {
  describe("supplemental-phase-workflow-assurance", () => {
    // contract_id: contract.ci-preset-assurance.verification
    // integration_id: supplemental-phase-workflow-assurance
    test('preflight accepts the authority-bound supplemental Action phase mappings', () => {
      const report = inspect(model());
      expect(report.mismatches).toStrictEqual([]);
      expect(report.missingSettings).toStrictEqual([]);
    });
  });
});

describe("contract.ci-preset-assurance.verification", () => {
  // contract_id: contract.ci-preset-assurance.verification
  // integration_id: authority-snapshot-preflight
  describe('authority snapshot preflight', () => {
    test('preserves static bindings and JSON string values', () => {
      const workflows = model();
      const publication = workflows.get('.github/workflows/release-publication.yml');
      publication.env.CI_RELEASE_OWNER_CONTRACT = 'owner"\\contract';
      expect(inspect(workflows).mismatches).toStrictEqual([]);

      const config = publication.jobs.authority.steps.find(step => step.id === 'config');
      const original = config.with['sources-json'];
      config.with['sources-json'] = original.replace(
        '${{ toJSON(env.CI_RELEASE_OWNER_CONTRACT) }}', JSON.stringify('owner"\\contract'),
      );
      expect(inspect(workflows).mismatches).toStrictEqual([]);
      config.with['sources-json'] = original;

      publication.env.CI_RELEASE_OWNER_CONTRACT = 'owner\ncontract';
      expect(inspect(workflows).mismatches.some(item => item.path.endsWith('env.CI_RELEASE_OWNER_CONTRACT'))).toBe(true);
    });

    test('rejects invalid templates with a snapshot parse diagnostic', () => {
      for (const source of [
        '{', 'null', '[]', undefined,
        '{"runtime":{"VALUE":${{ format("{0}", env.CI_LANGUAGE_PROFILE) }}},"workflow":{},"preset":{}}',
        '{"runtime":{"VALUE":${{ env.CI_LANGUAGE_PROFILE }}},"workflow":{},"preset":{}}',
        '{"runtime":{"VALUE":"literal: ${{ toJSON(env.CI_LANGUAGE_PROFILE) }}"},"workflow":{},"preset":{}}',
      ]) {
        const workflows = model();
        const config = workflows.get('.github/workflows/release-publication.yml').jobs.authority.steps.find(step => step.id === 'config');
        config.with['sources-json'] = source;
        const report = inspect(workflows);
        expect(report.mismatches.some(item => item.message === 'ci-config-snapshot sources-json must be a JSON object with supported static env/input bindings')).toBe(true);
      }
    });

    test('rejects JSON-encoded supplemental binding drift', () => {
      const workflows = model();
      const config = workflows.get('.github/workflows/release-publication.yml').jobs.authority.steps.find(step => step.id === 'config');
      config.with['sources-json'] = config.with['sources-json'].replace(
        'toJSON(inputs.supplemental_release_asset_owner_contract)', 'toJSON(env.CI_RELEASE_OWNER_CONTRACT)',
      );
      expect(inspect(workflows).mismatches.some(item => item.path.endsWith('workflow.CI_SUPPLEMENTAL_RELEASE_ASSET_OWNER_CONTRACT'))).toBe(true);
    });
  });
});

describe("publication-validation", () => {
  describe('preflight rejects supplemental phase bypasses and mismatched Action inputs', () => {
    const cases = [
      ['build', (step) => { step.with.operation = 'assemble'; }],
      ['build', (step) => { step.with['standard-build-root'] = 'other'; }],
      ['build', (step) => { step.if = 'always()'; }],
      ['build', (step) => { step['continue-on-error'] = true; }],
      ['supplemental-asset', (step) => { step.if = false; }],
      ['supplemental-asset', (step) => { delete step.with['supplemental-build-root']; }],
      ['supplemental-asset', (step) => { step.with['owner-adapter'] = 'override'; }],
      ['supplemental-asset', (step) => { delete step.uses; step.run = '.ci/scripts/ci-release-supplemental-asset.sh assemble authority/authority.json authority/config-snapshot.json build supplemental-build supplemental-asset'; step.shell = 'bash'; }],
    ];
    for (const [job, mutate] of cases) test(`${job}:${String(mutate)}`, () => {
      const workflows = model();
      mutate(phase(workflows, job));
      const report = inspect(workflows);
      expect(report.mismatches.some((item) => item.message.includes('current adapter interface'))).toBeTruthy();
    });
  });
});

describe("contract.ci-preset-assurance.verification", () => {
  describe("standard-release-authority-footprint", () => {
    // contract_id: contract.ci-preset-assurance.verification
    // integration_id: standard-release-authority-footprint
    test('standard Release authority requires no consumer script and rejects input binding drift', () => {
      const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
      const registry = loadRegistry(createReport());
      const workflows = model();
      const workflow = workflows.get('.github/workflows/release-publication.yml');
      workflow.env.CI_RELEASE_IMPLEMENTATION = 'rust-cli-release';
      workflow.env.CI_LANGUAGE_PROFILE = 'rust';
      expect(findWorkflowAssetReferences(repository, stringify(workflow)).includes('.ci/trusted/ci-release-authority.sh')).toBe(false);
      expect(registry.standardImplementations.find(item => item.id === 'rust-cli-release').fulfillsExtensions['release-authority-control']).toBe('ci-release-authority');
      expect(inspect(workflows).mismatches).toStrictEqual([]);
      for (const mutate of [
        step => { step.if = 'always()'; },
        step => { step.if = "env.CI_RELEASE_IMPLEMENTATION == 'rust-cli-release'"; },
        step => { step.uses = 'other/repo/actions/ci-release-authority@' + 'a'.repeat(40); },
        step => { step.uses = 'a3-suite/a3-ci-github/actions/ci-release-authority@main'; },
        step => { step.with['github-token'] = '${{ secrets.OTHER }}'; },
        step => { step.with['publication-request-run-id'] = 'other'; },
        step => { step['continue-on-error'] = true; },
        step => { delete step.uses; step.run = '.ci/trusted/ci-release-authority.sh'; },
      ]) {
        const changed = model();
        mutate(changed.get('.github/workflows/release-publication.yml').jobs.authority.steps.find(step => step.id === 'authority'));
        expect(inspect(changed).mismatches.some(item => item.message.includes('common read-only Action'))).toBeTruthy();
      }
      for (const field of ['release_version', 'target_identity']) {
        const changed = model();
        delete changed.get('.github/workflows/release-publication-request.yml').on.workflow_dispatch.inputs[field];
        expect(inspect(changed).mismatches.some(item => item.message.includes('explicit owner version and target'))).toBeTruthy();
      }
    });
  });
});

describe("publication-validation", () => {
  describe("publication-validation", () => {
    // Supplemental rejection coverage for the publication trust boundary.
    test('publication preflight enforces entry and control roles without an identity Action', (t) => {
      const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
      const parent = path.join(repository, 'tmp');
      fs.mkdirSync(parent, { recursive: true });
      const root = fs.mkdtempSync(path.join(parent, 'publication-control-'));
      t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
      const registry = loadRegistry(createReport());
      for (const kind of ['release', 'package']) {
        const preset = registry.presets.find(item => item.id === `${kind}-publication`);
        const asset = preset.workflowAssets.find(item => item.id === `${kind}-publication`) ?? { id: `${kind}-publication`, source: `.github/workflows/ci-${kind}-publication.yml`, destination: `.github/workflows/${kind}-publication.yml` };
        const filename = path.join(root, asset.destination);
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        const original = parse(fs.readFileSync(path.join(repository, `.github/workflows/ci-${kind}-publication.yml`), 'utf8'));
        const run = (workflow, selected = asset) => {
          const file = path.join(root, selected.destination);
          fs.writeFileSync(file, stringify(workflow));
          const report = createReport();
          const observed = new Set();
          inspectWorkflowAsset({ root, registry, parsed: new Map(), report,
            actionByPath: new Map(registry.actionTargets.map(target => [`${registry.actionRepository}/${target.actionPath}`, target])) }, preset, selected, observed);
          expect(observed.has('ci-workflow-identity')).toBe(false);
          return report;
        };
        const baseline = run(original);
        expect(baseline.mismatches.some(item => /publication control|trusted control checkout/.test(item.message))).toBe(false);
        const entryJob = kind === 'release' ? 'authority' : 'publish';
        for (const mutate of [
          job => { job.steps.shift(); },
          job => { job.steps[0].id = 'other'; },
          job => { job.steps[0].if = false; },
          job => { job.steps[0]['continue-on-error'] = true; },
          job => { job.steps[0].env.CONTROL_SHA = '${{ inputs.source_sha }}'; },
          job => { job.steps[0].env.CALLER_EVENT = 'workflow_run'; },
          job => { job.steps[0].run = 'true'; },
          job => { job.steps.unshift({ run: 'true', shell: 'bash' }); },
        ]) {
          const changed = structuredClone(original);
          mutate(changed.jobs[entryJob]);
          expect(run(changed).mismatches.some(item => item.message.startsWith('publication control drift:')), `${kind}: ${mutate}`).toBeTruthy();
        }
        for (const jobName of kind === 'release' ? ['authority', 'quality', 'assemble', 'publish'] : ['publish']) {
          for (const mutate of [
            (job, index) => { job.steps[index].with.ref = '${{ inputs.source_sha }}'; },
            (job, index) => { job.steps[index].with.ref = '${{ github.workflow_sha || github.sha }}'; },
            (job, index) => { job.steps[index].with.ref = 'main'; },
            (job, index) => { job.steps[index].with.repository = 'other/repository'; },
            (job, index) => { job.steps[index].with.path = 'source'; },
            (job, index) => { job.steps[index].if = false; },
            (job, index) => { job.steps[index]['continue-on-error'] = true; },
            (job, index) => { job.steps.splice(index + 1, 1); },
            (job, index) => { job.steps[index + 1].run = 'true'; },
            (job, index) => { job.steps[index + 1].env.CONTROL_SHA = '${{ inputs.source_sha }}'; },
            (job, index) => { job.steps[index + 1].if = false; },
            (job, index) => { job.steps[index + 1]['continue-on-error'] = true; },
            job => { job.container = 'ubuntu:24.04'; },
            job => { job.services = { service: { image: 'ubuntu:24.04' } }; },
          ]) {
            const changed = structuredClone(original);
            const job = changed.jobs[jobName];
            const index = job.steps.findIndex(step => step.with?.ref === '${{ github.workflow_sha }}');
            mutate(job, index);
            expect(run(changed).mismatches.some(item => /publication control|trusted control checkout/.test(item.message)), `${kind}/${jobName}: ${mutate}`).toBeTruthy();
          }
          if (jobName !== entryJob) for (const mutate of [
            job => { job.needs = [job.needs].flat().filter(name => name !== 'authority'); },
            job => { job.if = 'always()'; },
            job => { job.if = "!cancelled() && needs.authority.result != 'failure'"; },
          ]) {
            const changed = structuredClone(original);
            mutate(changed.jobs[jobName]);
            expect(run(changed).mismatches.some(item => item.message.startsWith('publication control drift:')), `${kind}/${jobName}: ${mutate}`).toBeTruthy();
          }
        }
        const callerAsset = preset.workflowAssets.find(item => item.id === `${kind}-publication-caller`);
        const caller = parse(fs.readFileSync(path.join(repository, `workflows/${kind}/${kind}-publication-caller.yml`), 'utf8'));
        for (const ref of [`./.github/workflows/other.yml`, `example/provider/.github/workflows/${kind}-publication.yml@main`]) {
          const changed = structuredClone(caller);
          changed.jobs.publish.uses = ref;
          expect(run(changed, callerAsset).mismatches.some(item => item.path.endsWith('jobs.publish.uses') && item.message.startsWith('canonical drift:'))).toBeTruthy();
        }
      }
      expect(registry.actionTargets.some(item => item.id === 'ci-workflow-identity')).toBe(false);
    });

    // Supplemental rejection coverage for the external publication workflow boundary.
    test('Release caller resolves provider publication without a consumer callee and validates its call contract', (t) => {
      const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
      const root = fs.mkdtempSync(path.join(repository, 'tmp', 'remote-release-'));
      t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
      const registry = loadRegistry(createReport());
      const preset = registry.presets.find(item => item.id === 'release-publication');
      expect(preset.workflowAssets.length).toBe(2);
      const asset = preset.workflowAssets.find(item => item.id === 'release-publication-caller');
      const caller = parse(fs.readFileSync(path.join(repository, 'workflows/release/release-publication-caller.yml'), 'utf8'));
      Object.assign(caller.jobs.publish.with, {
        runner: 'ubuntu-24.04', 'language-profile': 'rust', 'release-implementation': 'rust-cli-release',
        'standard-bundle-id': 'rust-cargo-quality', 'adapter-descriptor': '', 'sha256sum-version': '9.5', 'platform-manifest': '.ci/platform-manifest.yml',
        supplemental_release_asset_enabled: false, supplemental_release_asset_owner_contract: '__unset__',
        supplemental_release_asset_implementation: 'owner-adapter', supplemental_release_asset_config_path: '__unset__',
      });
      const filename = path.join(root, asset.destination);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      const requestAsset = preset.workflowAssets.find(item => item.id === 'release-publication-request');
      fs.copyFileSync(path.join(repository, requestAsset.source), path.join(root, requestAsset.destination));
      const run = (value) => {
        fs.writeFileSync(filename, stringify(value));
        const report = createReport();
        const parsed = new Map();
        const observed = new Set();
        inspectWorkflowAsset({ root, registry, parsed, report,
          actionByPath: new Map(registry.actionTargets.map(target => [`${registry.actionRepository}/${target.actionPath}`, target])) }, preset, asset, observed);
        validateCaller(asset.destination, value, parsed, report);
        validateQualityPreset({ root, registry, parsed, report }, preset);
        return { report, parsed, observed };
      };
      const pending = run(caller);
      expect(pending.report.missingSettings.some(item => item.message.includes('publication reusable workflow is pending-release'))).toBeTruthy();
      const providerSha = 'a'.repeat(40);
      registry.releasePublicationReusableWorkflow.status = 'available';
      registry.releasePublicationReusableWorkflow.exactRef = providerSha;
      caller.jobs.publish.uses = `${registry.actionRepository}/${registry.releasePublicationReusableWorkflow.source}@${providerSha}`;
      const baseline = run(caller);
      expect([...baseline.report.mismatches, ...baseline.report.missingSettings].some(item => item.path.startsWith(requestAsset.destination) && item.path.includes(':env.'))).toBe(false);
      expect(baseline.observed.has('ci-release-publisher')).toBeTruthy();
      const execution = baseline.parsed.get('.github/workflows/release-publication.yml');
      expect(execution.env.CI_RELEASE_IMPLEMENTATION).toBe('rust-cli-release');
      expect(execution.env.CI_SHA256SUM_VERSION).toBe('9.5');
      expect(baseline.report.missingSettings.some(item => item.path === '.ci/trusted/ci-release-publish.sh')).toBe(false);
      expect(fs.existsSync(path.join(root, '.github/workflows/release-publication.yml'))).toBe(false);
      const checkout = execution.jobs.publish.steps.find(step => step.with?.ref === '${{ github.workflow_sha }}');
      expect(checkout.with.repository).toBe('${{ github.repository }}');
      expect(checkout.with.ref).not.toBe(providerSha);
      for (const mutate of [
        value => { value.jobs.publish.uses = value.jobs.publish.uses.replace(providerSha, 'main'); },
        value => { value.jobs.publish.with.runner = '${{ github.event.workflow_run.head_branch }}'; },
        value => { value.jobs.publish.with['release-implementation'] = '${{ inputs.implementation }}'; },
        value => { value.jobs.publish.with['sha256sum-version'] = '${{ github.event.workflow_run.head_branch }}'; },
        value => { value.jobs.publish.with.supplemental_release_asset_enabled = '${{ inputs.enabled }}'; },
        value => { value.jobs.publish.with.supplemental_release_asset_owner_contract = '${{ inputs.contract }}'; },
        value => { value.jobs.publish.with.undeclared = 'value'; },
        value => { value.jobs.publish.with.runner = false; },
        value => { value.jobs.publish.permissions.contents = 'read'; },
        value => { value.jobs.publish.secrets = { UNDECLARED: '${{ secrets.OTHER }}' }; },
      ]) {
        const changed = structuredClone(caller); mutate(changed);
        expect(run(changed).report.mismatches.length > baseline.report.mismatches.length, String(mutate)).toBeTruthy();
      }
      fs.writeFileSync(filename, stringify(caller));
      const full = validateCiPresetInternal({ repoRoot: root, presets: ['release-publication'] }, false);
      expect(full.missingSettings.some(item => item.message.includes('pending-release'))).toBeTruthy();
      const wrong = structuredClone(caller); wrong.jobs.publish.with['release-implementation'] = 'unregistered';
      fs.writeFileSync(filename, stringify(wrong));
      const failed = validateCiPresetInternal({ repoRoot: root, presets: ['release-publication'] }, false);
      expect(failed.mismatches.some(item => item.message === 'release implementation is not registered'
        && item.path === `${asset.destination}:jobs.publish.with.release-implementation` && item.settingLocation === asset.destination)).toBeTruthy();
      expect([...failed.mismatches, ...failed.missingSettings].some(item => item.path.startsWith('.github/workflows/release-publication.yml:'))).toBe(false);
      const missing = structuredClone(caller); delete missing.jobs.publish.with.runner;
      expect(run(missing).report.missingSettings.some(item => item.message.includes('required reusable workflow input runner'))).toBeTruthy();
    });

    // Supplemental rejection coverage for Package publication and its external callee.
    test('Package caller retains explicit registry authority while resolving publication without a consumer callee', (t) => {
      const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
      const root = fs.mkdtempSync(path.join(repository, 'tmp', 'remote-package-'));
      t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
      const registry = loadRegistry(createReport());
      const preset = registry.presets.find(item => item.id === 'package-publication');
      expect(preset.workflowAssets.length).toBe(2);
      const asset = preset.workflowAssets.find(item => item.id === 'package-publication-caller');
      const caller = parse(fs.readFileSync(path.join(repository, asset.source), 'utf8'));
      Object.assign(caller.jobs.publish.with, { runner: 'ubuntu-24.04', 'gh-version': '2.65.0', 'jq-version': '1.7.1' });
      const filename = path.join(root, asset.destination);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      const request = preset.workflowAssets.find(item => item.id === 'package-publication-request');
      fs.copyFileSync(path.join(repository, request.source), path.join(root, request.destination));
      const run = (value) => {
        fs.writeFileSync(filename, stringify(value));
        const report = createReport(); const parsed = new Map(); const observed = new Set();
        inspectWorkflowAsset({ root, registry, parsed, report,
          actionByPath: new Map(registry.actionTargets.map(target => [`${registry.actionRepository}/${target.actionPath}`, target])) }, preset, asset, observed);
        validateCaller(asset.destination, value, parsed, report);
        return { report, parsed, observed };
      };
      expect(run(caller).report.missingSettings.some(item => item.message.includes('publication reusable workflow is pending-release'))).toBeTruthy();
      const providerSha = 'c'.repeat(40);
      registry.packagePublicationReusableWorkflow.status = 'available';
      registry.packagePublicationReusableWorkflow.exactRef = providerSha;
      caller.jobs.publish.uses = `${registry.actionRepository}/${registry.packagePublicationReusableWorkflow.source}@${providerSha}`;
      const baseline = run(caller);
      const publication = baseline.parsed.get('.github/workflows/package-publication.yml');
      expect(publication.env).toStrictEqual({ CI_GH_VERSION: '2.65.0', CI_JQ_VERSION: '1.7.1' });
      expect(baseline.observed.has('ci-handoff-integrity')).toBeTruthy();
      expect(fs.existsSync(path.join(root, '.github/workflows/package-publication.yml'))).toBe(false);
      const checkout = publication.jobs.publish.steps.find(step => step.with?.ref === '${{ github.workflow_sha }}');
      expect(checkout.with.repository).toBe('${{ github.repository }}');
      expect(checkout.with.ref).not.toBe(providerSha);
      expect(baseline.report.missingSettings.some(item => item.path === '.ci/trusted/ci-package-publish.sh')).toBeTruthy();
      for (const mutate of [
        value => { value.jobs.publish.uses = value.jobs.publish.uses.replace(providerSha, 'main'); },
        value => { value.jobs.publish.with.runner = '${{ github.event.workflow_run.head_branch }}'; },
        value => { value.jobs.publish.with['gh-version'] = '${{ inputs.tool }}'; },
        value => { value.jobs.publish.with['jq-version'] = false; },
        value => { value.jobs.publish.with.undeclared = 'value'; },
        value => { value.jobs.publish.permissions.packages = 'read'; },
        value => { value.jobs.publish.secrets.UNDECLARED = '${{ secrets.OTHER }}'; },
      ]) {
        const changed = structuredClone(caller); mutate(changed);
        expect(run(changed).report.mismatches.length > baseline.report.mismatches.length, String(mutate)).toBeTruthy();
      }
      const missing = structuredClone(caller); delete missing.jobs.publish.secrets.PACKAGE_REGISTRY_TOKEN;
      expect(run(missing).report.missingSettings.some(item => item.message.includes('required reusable workflow secret PACKAGE_REGISTRY_TOKEN'))).toBeTruthy();
      const missingInput = structuredClone(caller); delete missingInput.jobs.publish.with['jq-version'];
      expect(run(missingInput).report.missingSettings.some(item => item.message.includes('required reusable workflow input jq-version'))).toBeTruthy();
      const target = registry.actionTargets.find(item => item.id === 'ci-handoff-integrity');
      const allowlist = target.privilegedJobs; target.privilegedJobs = [];
      expect(run(caller).report.mismatches.some(item => item.message.includes('not allowlisted for write permissions: packages'))).toBeTruthy();
      target.privilegedJobs = allowlist;
      const actionRef = registry.actionExactRef; registry.actionExactRef = 'd'.repeat(40);
      expect(run(caller).report.mismatches.some(item => item.path.includes('ci-handoff-integrity') && item.message.includes('Action ref does not match'))).toBeTruthy();
      registry.actionExactRef = actionRef;
      fs.writeFileSync(filename, stringify(caller));
      const full = validateCiPresetInternal({ repoRoot: root, presets: ['package-publication'] }, false);
      expect(full.missingSettings.some(item => item.message.includes('publication reusable workflow is pending-release'))).toBeTruthy();
      expect([...full.mismatches, ...full.missingSettings].some(item => item.path.startsWith('.github/workflows/package-publication.yml:'))).toBe(false);
    });
  });
});


describe('standard installer preflight', () => {
  describe('selection', () => {
    test('recognizes only the authority snapshot consumed by the supplemental Action phases', () => {
      // Arrange
      const workflows = model();
      const original = workflows.get('.github/workflows/release-publication.yml');
      const callerPath = '.github/workflows/release-publication-caller.yml';
      workflows.get(callerPath).jobs.publish.with.supplemental_release_asset_enabled = true;
      const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
      const registry = loadRegistry(createReport());
      const preset = registry.presets.find(value => value.id === 'release-publication');
      const calleePath = path.join(repository, registry.releasePublicationReusableWorkflow.source);
      const readFile = fs.readFileSync;
      const entrypoint = '.ci/scripts/ci-release-supplemental-asset.sh';
      const cases = [
        publication => { publication.jobs.authority.steps.find(step => step.id === 'config').with['sources-json'] = '{}'; },
        publication => { const step = publication.jobs.authority.steps.find(step => step.id === 'config'); step.with['sources-json'] = step.with['sources-json'].replace(entrypoint, '../unsafe.sh'); },
        publication => { const step = publication.jobs.authority.steps.find(step => step.id === 'config'); step.with['sources-json'] = step.with['sources-json'].replace('inputs.supplemental_release_asset_implementation', 'inputs.other'); },
        publication => { publication.jobs.authority.steps.find(step => step.id === 'config').with['sources-json'] = '${{ inputs.snapshot }}'; },
        publication => { publication.jobs.authority.steps.find(step => step.id === 'config').uses = 'example/other@' + 'a'.repeat(40); },
        publication => { publication.jobs.authority.steps.find(step => step.id === 'config').with['snapshot-path'] = 'unconsumed.json'; },
        publication => { publication.jobs.build.steps.find(step => step.name === 'Build and verify supplemental Release asset platform').with['snapshot-path'] = 'unconsumed.json'; },
        publication => { publication.jobs['supplemental-asset'].if = false; },
      ];
      // Act / Assert
      expect(supplementalOwnerAdapterEntrypoint(original)).toBe(entrypoint);
      for (const mutate of cases) {
        const publication = structuredClone(original);
        mutate(publication);
        publication.env.INCIDENTAL_ADAPTER = entrypoint;
        expect(supplementalOwnerAdapterEntrypoint(publication)).toBeUndefined();
        const report = createReport();
        const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((filename, ...options) => filename === calleePath ? stringify(publication) : readFile(filename, ...options));
        try {
          validateConditionalExtensions({ root: repository, registry, parsed: workflows, report }, preset);
          expect(report.mismatches.some(item => item.message === 'enabled conditional extension is not reachable from the preset workflow')).toBe(true);
        } finally {
          spy.mockRestore();
        }
      }
    });

    test('validates the three static supplemental selections and rejects inconsistent inputs', () => {
      // Arrange
      const cases = [
        [false, '__unset__', 'owner-adapter', '__unset__'],
        [true, 'example.supplemental-asset-contract', 'owner-adapter', '__unset__'],
        [true, 'installer.asset-assembly-evidence-contract', 'standard-installer', 'installer/assembly.json'],
      ];
      for (const [enabled, ownerContract, implementation, configPath] of cases) {
        const workflows = model();
        const selection = workflows.get('.github/workflows/release-publication-caller.yml').jobs.publish.with;
        Object.assign(selection, { supplemental_release_asset_enabled: enabled, supplemental_release_asset_owner_contract: ownerContract, supplemental_release_asset_implementation: implementation, supplemental_release_asset_config_path: configPath });
        // Act / Assert
        expect(inspect(workflows).mismatches).toEqual([]);
        selection.supplemental_release_asset_config_path = implementation === 'owner-adapter' ? 'installer/assembly.json' : '../unsafe.json';
        expect(inspect(workflows).mismatches.length).toBeGreaterThan(0);
      }
    });

    test('accepts declarative standard selection without an owner adapter and rejects provider drift', (t) => {
      // Arrange
      const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
      const parent = path.join(repository, 'tests/tmp');
      fs.mkdirSync(parent, { recursive: true });
      const root = fs.mkdtempSync(path.join(parent, 'installer-preflight-'));
      t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
      const workflows = model();
      const caller = workflows.get('.github/workflows/release-publication-caller.yml');
      expect(caller.jobs.publish.with).toHaveProperty('supplemental_release_asset_implementation');
      expect(caller.jobs.publish.with).toHaveProperty('supplemental_release_asset_config_path');
      Object.assign(caller.jobs.publish.with, { supplemental_release_asset_enabled: true, supplemental_release_asset_owner_contract: 'installer.asset-assembly-evidence-contract', supplemental_release_asset_implementation: 'standard-installer', supplemental_release_asset_config_path: 'installer/assembly.json' });
      fs.mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
      fs.writeFileSync(path.join(root, '.github/workflows/release-publication-caller.yml'), stringify(caller));
      const registry = loadRegistry(createReport());
      const preset = registry.presets.find(value => value.id === 'release-publication');
      // Act
      const report = inspect(workflows);
      const inactive = inactiveConditionalEntrypoints(root, registry, preset);
      // Assert
      expect(report.mismatches).toEqual([]);
      expect(inactive.has('.ci/scripts/ci-release-supplemental-asset.sh')).toBe(true);
      for (const job of ['build', 'supplemental-asset']) {
        const selected = phase(workflows, job);
        const original = selected.env.A3_INSTALLER_PROVIDER_REVISION;
        selected.env.A3_INSTALLER_PROVIDER_REVISION = 'other';
        expect(inspect(workflows).mismatches.length).toBeGreaterThan(0);
        selected.env.A3_INSTALLER_PROVIDER_REVISION = original;
      }
    });
  });
});
