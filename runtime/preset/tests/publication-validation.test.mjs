import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { validateReleasePublicationFlow } from '../publication-validation.ts';
import { createReport } from '../validation-report.ts';

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
