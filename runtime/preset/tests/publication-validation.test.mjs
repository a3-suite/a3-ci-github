import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { validateReleasePublicationFlow } from '../publication-validation.ts';
import { createReport } from '../validation-report.ts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { loadRegistry } from '../ci-preset-assets.ts';
import { inspectWorkflowAsset } from '../workflow-validation.ts';
import { findWorkflowAssetReferences } from '../workflow-assets.ts';

const model = () => new Map(['release-publication-request', 'release-publication-caller', 'release-publication'].map((id) => [
  `.github/workflows/${id}.yml`, parse(fs.readFileSync(new URL(`../../../workflows/release/${id}.yml`, import.meta.url), 'utf8')),
]));
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
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const registry = loadRegistry(createReport());
  const preset = registry.presets.find(preset => preset.id === 'release-publication');
  const asset = preset.workflowAssets.find(asset => asset.id === 'release-publication');
  const filename = path.join(root, asset.destination);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const workflow = parse(fs.readFileSync(path.join(repository, 'workflows/release/release-publication.yml'), 'utf8'));
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

test('preflight rejects supplemental phase bypasses and mismatched Action inputs', async (t) => {
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
  for (const [job, mutate] of cases) await t.test(`${job}:${String(mutate)}`, () => {
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
