import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'vitest';
import { parse } from 'yaml';
import { validateCaller, validateReleasePublicationFlow } from '../publication-validation.ts';
import { createReport } from '../validation-report.ts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { loadRegistry } from '../preset-registry.ts';
import { resolvePublicationWorkflow } from '../ci-preset-assets.ts';
import { inspectWorkflowAsset } from '../workflow-validation.ts';
import { validateCiPresetInternal } from '../validate-ci-preset-core.ts';
import { validateQualityPreset } from '../quality-validation.ts';
import { findWorkflowAssetReferences } from '../workflow-assets.ts';

const model = () => {
  const workflows = new Map(['release-publication-request', 'release-publication-caller'].map((id) => [
    `.github/workflows/${id}.yml`, parse(fs.readFileSync(new URL(`../../../workflows/release/${id}.yml`, import.meta.url), 'utf8')),
  ]));
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
  assert.equal(findWorkflowAssetReferences(root, original).includes('.ci/trusted/ci-release-publish.sh'), false);
  const run = (value) => {
    fs.writeFileSync(filename, stringify(value));
    const report = createReport();
    inspectWorkflowAsset({ root, registry, parsed: new Map(), report,
      actionByPath: new Map(registry.actionTargets.map(target => [`${registry.actionRepository}/${target.actionPath}`, target])) }, preset, asset, new Set());
    return report;
  };
  assert.equal(run(workflow).missingSettings.some(item => item.path === '.ci/trusted/ci-release-publish.sh'), false);
  assert.equal(fs.existsSync(path.join(root, '.ci')), false);
  assert.equal(registry.standardImplementations.find(item => item.id === 'rust-cli-release').fulfillsExtensions['release-publication-adapter'], 'ci-release-publisher');
  for (const mutate of [
    step => { step.if = 'always()'; },
    step => { step.with['authority-path'] = 'other.json'; },
    step => { step.env.GH_TOKEN = '${{ secrets.OTHER }}'; },
    step => { step['continue-on-error'] = true; },
    step => { step.run = '.ci/trusted/ci-release-publish.sh'; delete step.uses; },
  ]) {
    const changed = parse(original);
    mutate(changed.jobs.publish.steps.find(step => step.id === 'publish'));
    assert.ok(run(changed).mismatches.some(item => item.message.startsWith('canonical drift:') && item.path.includes('jobs.publish.steps')));
  }
  const ownerFallback = parse(original);
  ownerFallback.jobs.publish.steps.find(step => step.id === 'publish_owner').if = 'always()';
  assert.ok(run(ownerFallback).mismatches.some(item => item.message.startsWith('canonical drift:')));
});

// contract_id: contract.ci-preset-assurance.verification
// integration_id: supplemental-phase-workflow-assurance
test('preflight accepts the authority-bound supplemental Action phase mappings', () => {
  const report = inspect(model());
  assert.deepEqual(report.mismatches, []);
  assert.deepEqual(report.missingSettings, []);
});

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
    assert.ok(report.mismatches.some((item) => item.message.includes('current adapter interface')));
  });
});

// contract_id: contract.ci-preset-assurance.verification
// integration_id: standard-release-authority-footprint
test('standard Release authority requires no consumer script and rejects input binding drift', () => {
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const registry = loadRegistry(createReport());
  const workflows = model();
  const workflow = workflows.get('.github/workflows/release-publication.yml');
  workflow.env.CI_RELEASE_IMPLEMENTATION = 'rust-cli-release';
  workflow.env.CI_LANGUAGE_PROFILE = 'rust';
  assert.equal(findWorkflowAssetReferences(repository, stringify(workflow)).includes('.ci/trusted/ci-release-authority.sh'), false);
  assert.equal(registry.standardImplementations.find(item => item.id === 'rust-cli-release').fulfillsExtensions['release-authority-control'], 'ci-release-authority');
  assert.deepEqual(inspect(workflows).mismatches, []);
  for (const mutate of [
    step => { step.if = 'always()'; },
    step => { step.with['github-token'] = '${{ secrets.OTHER }}'; },
    step => { step.with['publication-request-run-id'] = 'other'; },
    step => { step['continue-on-error'] = true; },
    step => { delete step.uses; step.run = '.ci/trusted/ci-release-authority.sh'; },
  ]) {
    const changed = model();
    mutate(changed.get('.github/workflows/release-publication.yml').jobs.authority.steps.find(step => step.id === 'authority'));
    assert.ok(inspect(changed).mismatches.some(item => item.message.includes('common read-only Action')));
  }
  for (const field of ['release_version', 'target_identity']) {
    const changed = model();
    delete changed.get('.github/workflows/release-publication-request.yml').on.workflow_dispatch.inputs[field];
    assert.ok(inspect(changed).mismatches.some(item => item.message.includes('explicit owner version and target')));
  }
});

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
      assert.equal(observed.has('ci-workflow-identity'), false);
      return report;
    };
    const baseline = run(original);
    assert.equal(baseline.mismatches.some(item => /publication control|trusted control checkout/.test(item.message)), false);
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
      assert.ok(run(changed).mismatches.some(item => item.message.startsWith('publication control drift:')), `${kind}: ${mutate}`);
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
        assert.ok(run(changed).mismatches.some(item => /publication control|trusted control checkout/.test(item.message)), `${kind}/${jobName}: ${mutate}`);
      }
      if (jobName !== entryJob) for (const mutate of [
        job => { job.needs = [job.needs].flat().filter(name => name !== 'authority'); },
        job => { job.if = 'always()'; },
        job => { job.if = "!cancelled() && needs.authority.result != 'failure'"; },
      ]) {
        const changed = structuredClone(original);
        mutate(changed.jobs[jobName]);
        assert.ok(run(changed).mismatches.some(item => item.message.startsWith('publication control drift:')), `${kind}/${jobName}: ${mutate}`);
      }
    }
    const callerAsset = preset.workflowAssets.find(item => item.id === `${kind}-publication-caller`);
    const caller = parse(fs.readFileSync(path.join(repository, `workflows/${kind}/${kind}-publication-caller.yml`), 'utf8'));
    for (const ref of [`./.github/workflows/other.yml`, `example/provider/.github/workflows/${kind}-publication.yml@main`]) {
      const changed = structuredClone(caller);
      changed.jobs.publish.uses = ref;
      assert.ok(run(changed, callerAsset).mismatches.some(item => item.path.endsWith('jobs.publish.uses') && item.message.startsWith('canonical drift:')));
    }
  }
  assert.deepEqual(registry.actionTargets.find(item => item.id === 'ci-workflow-identity').workflows, []);
});

// Supplemental rejection coverage for the external publication workflow boundary.
test('Release caller resolves provider publication without a consumer callee and validates its call contract', (t) => {
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const root = fs.mkdtempSync(path.join(repository, 'tmp', 'remote-release-'));
  t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const registry = loadRegistry(createReport());
  const preset = registry.presets.find(item => item.id === 'release-publication');
  assert.equal(preset.workflowAssets.length, 2);
  const asset = preset.workflowAssets.find(item => item.id === 'release-publication-caller');
  const caller = parse(fs.readFileSync(path.join(repository, 'workflows/release/release-publication-caller.yml'), 'utf8'));
  Object.assign(caller.jobs.publish.with, {
    runner: 'ubuntu-24.04', 'language-profile': 'rust', 'release-implementation': 'rust-cli-release',
    'standard-bundle-id': 'rust-cargo-quality', 'adapter-descriptor': '', 'sha256sum-version': '9.5', 'platform-manifest': '.ci/platform-manifest.yml',
    supplemental_release_asset_enabled: false, supplemental_release_asset_owner_contract: '__unset__',
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
  assert.ok(pending.report.missingSettings.some(item => item.message.includes('publication reusable workflow is pending-release')));
  const providerSha = 'a'.repeat(40);
  registry.releasePublicationReusableWorkflow.status = 'available';
  registry.releasePublicationReusableWorkflow.exactRef = providerSha;
  caller.jobs.publish.uses = `${registry.actionRepository}/${registry.releasePublicationReusableWorkflow.source}@${providerSha}`;
  const baseline = run(caller);
  assert.equal([...baseline.report.mismatches, ...baseline.report.missingSettings].some(item => item.path.startsWith(requestAsset.destination) && item.path.includes(':env.')), false);
  assert.ok(baseline.observed.has('ci-release-publisher'));
  const execution = baseline.parsed.get('.github/workflows/release-publication.yml');
  assert.equal(execution.env.CI_RELEASE_IMPLEMENTATION, 'rust-cli-release');
  assert.equal(execution.env.CI_SHA256SUM_VERSION, '9.5');
  assert.equal(baseline.report.missingSettings.some(item => item.path === '.ci/trusted/ci-release-publish.sh'), false);
  assert.equal(fs.existsSync(path.join(root, '.github/workflows/release-publication.yml')), false);
  const checkout = execution.jobs.publish.steps.find(step => step.with?.ref === '${{ github.workflow_sha }}');
  assert.equal(checkout.with.repository, '${{ github.repository }}');
  assert.notEqual(checkout.with.ref, providerSha);
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
    assert.ok(run(changed).report.mismatches.length > baseline.report.mismatches.length, String(mutate));
  }
  fs.writeFileSync(filename, stringify(caller));
  const full = validateCiPresetInternal({ repoRoot: root, presets: ['release-publication'] }, false);
  assert.ok(full.missingSettings.some(item => item.message.includes('pending-release')));
  const wrong = structuredClone(caller); wrong.jobs.publish.with['release-implementation'] = 'unregistered';
  fs.writeFileSync(filename, stringify(wrong));
  const failed = validateCiPresetInternal({ repoRoot: root, presets: ['release-publication'] }, false);
  assert.ok(failed.mismatches.some(item => item.message === 'release implementation is not registered'
    && item.path === `${asset.destination}:jobs.publish.with.release-implementation` && item.settingLocation === asset.destination));
  assert.equal([...failed.mismatches, ...failed.missingSettings].some(item => item.path.startsWith('.github/workflows/release-publication.yml:')), false);
  const missing = structuredClone(caller); delete missing.jobs.publish.with.runner;
  assert.ok(run(missing).report.missingSettings.some(item => item.message.includes('required reusable workflow input runner')));
});

// Supplemental rejection coverage for Package publication and its external callee.
test('Package caller retains explicit registry authority while resolving publication without a consumer callee', (t) => {
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const root = fs.mkdtempSync(path.join(repository, 'tmp', 'remote-package-'));
  t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const registry = loadRegistry(createReport());
  const preset = registry.presets.find(item => item.id === 'package-publication');
  assert.equal(preset.workflowAssets.length, 2);
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
  assert.ok(run(caller).report.missingSettings.some(item => item.message.includes('publication reusable workflow is pending-release')));
  const providerSha = 'c'.repeat(40);
  registry.packagePublicationReusableWorkflow.status = 'available';
  registry.packagePublicationReusableWorkflow.exactRef = providerSha;
  caller.jobs.publish.uses = `${registry.actionRepository}/${registry.packagePublicationReusableWorkflow.source}@${providerSha}`;
  const baseline = run(caller);
  const publication = baseline.parsed.get('.github/workflows/package-publication.yml');
  assert.deepEqual(publication.env, { CI_GH_VERSION: '2.65.0', CI_JQ_VERSION: '1.7.1' });
  assert.ok(baseline.observed.has('ci-handoff-integrity'));
  assert.equal(fs.existsSync(path.join(root, '.github/workflows/package-publication.yml')), false);
  const checkout = publication.jobs.publish.steps.find(step => step.with?.ref === '${{ github.workflow_sha }}');
  assert.equal(checkout.with.repository, '${{ github.repository }}');
  assert.notEqual(checkout.with.ref, providerSha);
  assert.ok(baseline.report.missingSettings.some(item => item.path === '.ci/trusted/ci-package-publish.sh'));
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
    assert.ok(run(changed).report.mismatches.length > baseline.report.mismatches.length, String(mutate));
  }
  const missing = structuredClone(caller); delete missing.jobs.publish.secrets.PACKAGE_REGISTRY_TOKEN;
  assert.ok(run(missing).report.missingSettings.some(item => item.message.includes('required reusable workflow secret PACKAGE_REGISTRY_TOKEN')));
  const missingInput = structuredClone(caller); delete missingInput.jobs.publish.with['jq-version'];
  assert.ok(run(missingInput).report.missingSettings.some(item => item.message.includes('required reusable workflow input jq-version')));
  const target = registry.actionTargets.find(item => item.id === 'ci-handoff-integrity');
  const allowlist = target.privilegedJobs; target.privilegedJobs = [];
  assert.ok(run(caller).report.mismatches.some(item => item.message.includes('not allowlisted for write permissions: packages')));
  target.privilegedJobs = allowlist;
  const actionRef = registry.actionExactRef; registry.actionExactRef = 'd'.repeat(40);
  assert.ok(run(caller).report.mismatches.some(item => item.path.includes('ci-handoff-integrity') && item.message.includes('Action ref does not match')));
  registry.actionExactRef = actionRef;
  fs.writeFileSync(filename, stringify(caller));
  const full = validateCiPresetInternal({ repoRoot: root, presets: ['package-publication'] }, false);
  assert.ok(full.missingSettings.some(item => item.message.includes('publication reusable workflow is pending-release')));
  assert.equal([...full.mismatches, ...full.missingSettings].some(item => item.path.startsWith('.github/workflows/package-publication.yml:')), false);
});
