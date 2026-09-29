import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');
const includesAll = (text, values) => values.forEach((value) => assert.match(text, value));
const jobBlock = (workflow, id) => {
  const marker = `\n  ${id}:\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `missing job: ${id}`);
  const bodyStart = start + marker.length;
  const remainder = workflow.slice(bodyStart);
  const next = remainder.search(/\n  [a-zA-Z0-9_-]+:\n/);
  return next === -1 ? remainder : remainder.slice(0, next);
};
const stepsOf = (job) => job.split(/\n(?=      - )/).filter((entry) => entry.startsWith('      - '));
const stepContaining = (job, marker) => {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^\\s*${escaped}$`, 'm');
  const found = stepsOf(job).find((step) => pattern.test(step));
  assert.ok(found, `missing step containing: ${marker}`);
  return found;
};
const stepIndexContaining = (job, marker) => {
  const steps = stepsOf(job);
  const index = steps.indexOf(stepContaining(job, marker));
  assert.notEqual(index, -1, `missing ordered step: ${marker}`);
  return index;
};
const stepBlock = (job, marker) => {
  const start = job.indexOf(`      ${marker}\n`);
  assert.notEqual(start, -1, `missing step: ${marker}`);
  const remainder = job.slice(start);
  const next = remainder.slice(1).search(/\n      - (?:name:|uses:)/);
  return next === -1 ? remainder : remainder.slice(0, next + 1);
};
const summaryNeeds = (summary) => {
  const inline = summary.match(/^    needs: \[([^\]]+)\]$/m);
  if (inline) return inline[1].split(',').map((value) => value.trim());
  const scalar = summary.match(/^    needs: ([a-zA-Z0-9_-]+)$/m);
  assert.ok(scalar, 'summary needs must use a scalar or inline list');
  return [scalar[1]];
};
const assertNeeds = (job, expected) => {
  assert.deepEqual([...summaryNeeds(job)].sort(), [...expected].sort());
};
const unitRecord = (summary, unit) => {
  const marker = `\"unit\":\"${unit}\"`;
  const start = summary.indexOf(marker);
  assert.notEqual(start, -1, `missing summary unit: ${unit}`);
  const remainder = summary.slice(start);
  const end = remainder.search(/\},\{\"unit\"|\}\]\}/);
  assert.notEqual(end, -1, `unterminated summary unit: ${unit}`);
  return remainder.slice(0, end + 1);
};

// integration_id: quality-workflow-contract
test('quality workflow declares trusted execution and aggregate summary', () => {
  const workflow = read('workflows/quality/quality-gate.yml');
  includesAll(workflow, [/pull_request:/, /push:/, /permissions:\n  contents: read/]);
  const trusted = jobBlock(workflow, 'trusted');
  assert.match(trusted, /^    if: \$\{\{ github\.event_name != 'pull_request' \|\| github\.event\.pull_request\.head\.repo\.full_name == github\.repository \}\}$/m);
  includesAll(stepBlock(trusted, '- uses: actions/checkout@<commit-sha>'), [
    /^      - uses: actions\/checkout@<commit-sha>$/m,
    /^          ref: \$\{\{ github\.event_name == 'pull_request' && github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}$/m,
  ]);
  includesAll(stepBlock(trusted, '- name: Checkout trusted CI assets'), [
    /^        uses: actions\/checkout@<commit-sha>$/m,
    /^          ref: \$\{\{ github\.event_name == 'pull_request' && github\.event\.pull_request\.base\.sha \|\| github\.sha \}\}$/m,
    /^          path: \.ci-base$/m,
  ]);
  includesAll(stepBlock(trusted, '- name: Run project quality adapter'), [
    /^        id: quality-adapter$/m,
    /^        uses: a3-suite\/a3-ci-github\/actions\/ci-quality-adapter@312c534de67720de060689d78ada17da9c84c4e2$/m,
    /^          trusted-project-root: \$\{\{ steps\.trusted-assets\.outputs\.root \}\}$/m,
  ]);
  const untrusted = jobBlock(workflow, 'untrusted-pr');
  assert.match(untrusted, /^    if: \$\{\{ github\.event_name == 'pull_request' && github\.event\.pull_request\.head\.repo\.full_name != github\.repository \}\}$/m);
  includesAll(stepBlock(untrusted, '- uses: actions/checkout@<commit-sha>'), [
    /^          ref: \$\{\{ github\.event_name == 'pull_request' && github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}$/m,
  ]);
  includesAll(stepBlock(untrusted, '- name: Checkout trusted CI assets'), [
    /^          ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}$/m,
    /^          path: \.ci-base$/m,
  ]);
  includesAll(stepBlock(untrusted, '- name: Run project quality adapter'), [
    /^        uses: a3-suite\/a3-ci-github\/actions\/ci-quality-adapter@312c534de67720de060689d78ada17da9c84c4e2$/m,
    /^          bundle-path: \.ci-base\/\$\{\{ env\.CI_ADAPTER_DESCRIPTOR \}\}$/m,
  ]);
  const summary = jobBlock(workflow, 'summary');
  assertNeeds(summary, ['trusted', 'untrusted-pr']);
  includesAll(summary, [/if: always\(\)/, /uses: a3-suite\/a3-ci-github\/actions\/ci-quality-summary@/]);
});

// integration_id: quality-workflow-contract
test('optional platform quality workflow preserves trusted assets matrix execution and summary', () => {
  const workflow = read('workflows/quality/quality-gate-platforms.yml');
  const resolve = jobBlock(workflow, 'resolve-platforms');
  includesAll(resolve, [
    /id: trusted-assets/,
    /pull_request\.base\.sha/,
    /matrix: .*steps\.resolve\.outputs\.matrix/,
    /expected: .*steps\.resolve\.outputs\.expected/,
    /allowed_runners/,
    /CoreLoader/,
    /duplicate mapping key/,
    /platform manifest exceeds 64 KiB/,
    /exceeds alias count limit/,
    /platform selection must contain only a non-empty platforms list/,
    /platform selection entry must contain only an id/,
    /platform manifest must contain only a platforms list/,
    /platform manifest must contain at least one platform/,
    /platform id is duplicated in the manifest/,
    /platform id is invalid in the manifest/,
    /runner is not allowed by the platform manifest contract/,
    /platform target is invalid in the manifest/,
  ]);
  includesAll(jobBlock(workflow, 'platform'), [
    /needs: resolve-platforms/,
    /matrix: .*needs\.resolve-platforms\.outputs\.matrix/,
    /trusted-project-root: .*trusted_root/,
    /uses: a3-suite\/a3-ci-github\/actions\/ci-quality-adapter@/,
  ]);
  const summary = jobBlock(workflow, 'platform-summary');
  assertNeeds(summary, ['resolve-platforms', 'platform']);
  includesAll(summary, [
    /if: always\(\)/,
    /EXPECTED_PLATFORMS/,
    /uses: a3-suite\/a3-ci-github\/actions\/ci-quality-summary@/,
  ]);
});

// integration_id: quality-workflow-contract
test('quality workflow keeps failed or missing checks visible', () => {
  const summary = jobBlock(read('workflows/quality/quality-gate.yml'), 'summary');
  includesAll(summary, [
    /if: always\(\)/,
    /"rawResult":"\$\{\{ needs\.trusted\.result \}\}"/,
    /"applicable":\$\{\{ needs\.trusted\.result != 'skipped' \}\}/,
    /"rawResult":"\$\{\{ needs\.untrusted-pr\.result \}\}"/,
    /"applicable":\$\{\{ needs\.trusted\.result == 'skipped' \}\}/,
  ]);
});

// contract_id: contract.ci-selective-distribution.publication
// integration_id: repository-selective-distribution-release
test('repository release publishes and reads back the exact selective distribution asset set before aliases', () => {
  const workflow = read('.github/workflows/release.yml');
  assert.match(workflow, /^permissions: \{\}$/m);
  const prepare = jobBlock(workflow, 'prepare-distribution');
  includesAll(prepare, [
    /contents: read/,
    /CI_RELEASE_VALIDATE_ONLY: 'true'/,
    /source_sha: \$\{\{ steps\.release-identity\.outputs\.source_sha \}\}/,
    /tag_object: \$\{\{ steps\.release-identity\.outputs\.tag_object \}\}/,
    /generate-distribution-release\.ts/,
    /a3-ci-github-distribution-manifest\.json/,
    /fetch-a3-ci-github\.mjs/,
    /SHA256SUMS/,
    /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/,
  ]);
  assert.doesNotMatch(prepare, /GH_TOKEN|contents: write/);
  const publish = jobBlock(workflow, 'publish-distribution');
  assertNeeds(publish, ['prepare-distribution']);
  includesAll(publish, [
    /actions: read/,
    /contents: write/,
    /manage-distribution-release\.sh publish release-distribution/,
    /GH_TOKEN: \$\{\{ github\.token \}\}/,
    /EXPECTED_SOURCE_SHA: \$\{\{ needs\.prepare-distribution\.outputs\.source_sha \}\}/,
    /EXPECTED_TAG_OBJECT: \$\{\{ needs\.prepare-distribution\.outputs\.tag_object \}\}/,
  ]);
  assert.doesNotMatch(publish, /--clobber|--force/);
  const readback = jobBlock(workflow, 'readback-distribution');
  assertNeeds(readback, ['prepare-distribution', 'publish-distribution']);
  includesAll(readback, [
    /contents: read/,
    /manage-distribution-release\.sh readback release-distribution/,
    /GH_TOKEN: \$\{\{ github\.token \}\}/,
  ]);
  const aliases = jobBlock(workflow, 'update-aliases');
  assertNeeds(aliases, ['readback-distribution']);
  assert.match(aliases, /runtime\/repository\/update-release-aliases\.sh/);
  const summary = jobBlock(workflow, 'summary');
  assertNeeds(summary, [
    'prepare-distribution',
    'publish-distribution',
    'readback-distribution',
    'update-aliases',
  ]);
  includesAll(summary, [/if: always\(\)/, /test "\$READBACK_RESULT" = success/]);
});

// integration_id: release-request-workflow-contract
test('release request workflow binds annotated tags without release publication permission', () => {
  const workflow = read('workflows/release/release-request-tag.yml');
  assert.match(workflow, /push:\n    tags:/);
  includesAll(jobBlock(workflow, 'request'), [/permissions:\n      actions: write\n      contents: read/, /ci-annotated-tag-resolver@/, /ci-release-request-handoff@/]);
  assert.doesNotMatch(workflow, /contents: write/);
  includesAll(jobBlock(workflow, 'summary'), [/needs: request/, /if: always\(\)/, /ci-quality-summary@/]);
});

// integration_id: release-request-workflow-contract
test('release request workflow reports handoff failure in its summary', () => {
  const summary = jobBlock(read('workflows/release/release-request-tag.yml'), 'summary');
  includesAll(summary, [/if: always\(\)/, /ci-quality-summary@/, /request job result:/, /"rawResult":"\$\{\{ needs\.request\.result \}\}"/]);
});

// integration_id: release-publication-workflow-contract
test('release publication workflows separate request validation from privileged publication', () => {
  const request = read('workflows/release/release-publication-request.yml');
  const caller = read('workflows/release/release-publication-caller.yml');
  const publication = read('workflows/release/release-publication.yml');
  assert.match(request, /workflow_dispatch:/);
  includesAll(jobBlock(request, 'request'), [/contents: read/, /operation: create-request/]);
  includesAll(jobBlock(request, 'summary'), [/needs: request/, /if: always\(\)/, /ci-quality-summary@/]);
  assert.match(caller, /workflow_run:/);
  includesAll(jobBlock(caller, 'validate-request'), [/actions: read/, /contents: read/, /operation: verify-publication-request/]);
  const callerPublish = jobBlock(caller, 'publish');
  assertNeeds(callerPublish, ['validate-request']);
  includesAll(callerPublish, [/contents: write/, /uses: \.\/\.github\/workflows\/release-publication\.yml/]);
  const callerSummary = jobBlock(caller, 'summary');
  assertNeeds(callerSummary, ['validate-request', 'publish']);
  includesAll(callerSummary, [/if: always\(\)/, /ci-quality-summary@/]);
  assert.match(publication, /workflow_call:/);
  includesAll(jobBlock(publication, 'authority'), [/Verify workflow identity/, /Verify publication request workflow run/]);
  const buildJob = jobBlock(publication, 'build');
  assertNeeds(buildJob, ['authority', 'source-gate', 'quality']);
  includesAll(stepContaining(buildJob, '- name: Build and verify supplemental Release asset platform'), [
    /^        if: inputs\.supplemental_release_asset_enabled$/m,
    /^        shell: bash$/m,
  ]);
  includesAll(stepContaining(buildJob, 'name: supplemental-build-${{ matrix.id }}'), [
    /actions\/upload-artifact@/,
    /^        if: inputs\.supplemental_release_asset_enabled$/m,
    /^          path: supplemental-build\/\$\{\{ matrix\.id \}\}$/m,
    /^          if-no-files-found: error$/m,
  ]);
  includesAll(stepContaining(buildJob, 'name: release-build-${{ matrix.id }}'), [
    /actions\/upload-artifact@/,
    /^          path: build\/\$\{\{ matrix\.id \}\}$/m,
    /^          if-no-files-found: error$/m,
  ]);
  const supplementalAssetJob = jobBlock(publication, 'supplemental-asset');
  assertNeeds(supplementalAssetJob, ['authority', 'source-gate', 'quality', 'build']);
  includesAll(supplementalAssetJob, [
    /^    if: inputs\.supplemental_release_asset_enabled$/m,
  ]);
  includesAll(stepContaining(supplementalAssetJob, 'pattern: release-build-*'), [
    /actions\/download-artifact@/,
    /^          path: build$/m,
  ]);
  includesAll(stepContaining(supplementalAssetJob, 'pattern: supplemental-build-*'), [
    /actions\/download-artifact@/,
    /^          path: supplemental-build$/m,
  ]);
  includesAll(stepContaining(supplementalAssetJob, '- name: Build and verify supplemental Release asset'), [
    /^        shell: bash$/m,
  ]);
  const publicationJob = jobBlock(publication, 'publish');
  assertNeeds(publicationJob, ['authority', 'assemble']);
  assert.match(publicationJob, /contents: write/);
  assert.ok(stepIndexContaining(publicationJob, '- name: Verify workflow identity') < stepIndexContaining(publicationJob, '- name: Validate release handoff integrity'));
  assert.ok(stepIndexContaining(publicationJob, '- name: Validate release handoff integrity') < stepIndexContaining(publicationJob, '- name: Verify approval is still valid'));
  assert.ok(stepIndexContaining(publicationJob, '- name: Verify approval is still valid') < stepIndexContaining(publicationJob, '- id: publish'));
  assert.ok(stepIndexContaining(publicationJob, '- id: publish') < stepIndexContaining(publicationJob, '- name: Verify publication readback evidence'));
  assert.doesNotMatch(publicationJob.split(/^    steps:$/m)[0], /GH_TOKEN|CI_GITHUB_TOKEN/);
  includesAll(stepContaining(publicationJob, '- id: publish'), [/GH_TOKEN: \$\{\{ github\.token \}\}/, /CI_GITHUB_TOKEN: \$\{\{ github\.token \}\}/]);
  const publicationSummary = jobBlock(publication, 'summary');
  assertNeeds(publicationSummary, ['authority', 'source-gate', 'quality', 'build', 'supplemental-asset', 'assemble', 'publish']);
  includesAll(publicationSummary, [/if: always\(\)/, /ci-quality-summary@/]);
});

// integration_id: release-publication-workflow-contract
test('release publication workflows preserve failed and unknown outcomes', () => {
  includesAll(jobBlock(read('workflows/release/release-publication-request.yml'), 'summary'), [/if: always\(\)/, /"rawResult":"\$\{\{ needs\.request\.result \}\}"/]);
  includesAll(jobBlock(read('workflows/release/release-publication-caller.yml'), 'summary'), [/if: always\(\)/, /"rawResult":"\$\{\{ needs\.publish\.result \}\}"/]);
});

// integration_id: package-publication-workflow-contract
test('package workflows separate preparation request validation and publication', () => {
  const request = read('workflows/package/package-publication-request.yml');
  const caller = read('workflows/package/package-publication-caller.yml');
  const preparation = read('workflows/package/package-preparation.yml');
  const publication = read('workflows/package/package-publication.yml');
  assert.match(request, /workflow_dispatch:/);
  includesAll(jobBlock(request, 'request'), [/permissions: \{\}/, /operation: create/]);
  includesAll(jobBlock(request, 'summary'), [/needs: request/, /if: always\(\)/, /ci-quality-summary@/]);
  assert.match(caller, /workflow_run:/);
  includesAll(jobBlock(caller, 'validate-request'), [/actions: read/, /operation: verify/]);
  const prepareJob = jobBlock(caller, 'prepare');
  assertNeeds(prepareJob, ['validate-request']);
  assert.match(prepareJob, /uses: \.\/\.github\/workflows\/package-preparation\.yml/);
  const publishJob = jobBlock(caller, 'publish');
  assertNeeds(publishJob, ['validate-request', 'prepare']);
  includesAll(publishJob, [/packages: write/, /uses: \.\/\.github\/workflows\/package-publication\.yml/]);
  const callerSummary = jobBlock(caller, 'summary');
  assertNeeds(callerSummary, ['validate-request', 'prepare', 'publish']);
  includesAll(callerSummary, [/if: always\(\)/, /ci-quality-summary@/]);
  assert.match(preparation, /workflow_call:/);
  assert.match(jobBlock(preparation, 'build'), /needs: version-plan/);
  assert.match(publication, /workflow_call:/);
  const publicationJob = jobBlock(publication, 'publish');
  includesAll(publicationJob, [
    /packages: write/,
    /^      - name: Verify workflow identity$/m,
    /^        uses: a3-suite\/a3-ci-github\/actions\/ci-workflow-identity@312c534de67720de060689d78ada17da9c84c4e2$/m,
    /expected-called-workflow-path: .github\/workflows\/package-publication\.yml/,
  ]);
  assert.ok(stepIndexContaining(publicationJob, '- name: Verify workflow identity') < stepIndexContaining(publicationJob, '- name: Validate package handoff integrity'));
  assert.ok(stepIndexContaining(publicationJob, '- name: Validate package handoff integrity') < stepIndexContaining(publicationJob, '- name: Publish verified package handoff'));
  assert.doesNotMatch(publicationJob.split(/^    steps:$/m)[0], /PACKAGE_REGISTRY_TOKEN|CI_GITHUB_TOKEN/);
  includesAll(stepContaining(publicationJob, '- name: Publish verified package handoff'), [
    /PACKAGE_REGISTRY_TOKEN: \$\{\{ secrets\.PACKAGE_REGISTRY_TOKEN \}\}/,
    /CI_GITHUB_TOKEN: \$\{\{ github\.token \}\}/,
  ]);
  assert.doesNotMatch(publication, /expected_caller=/);
  includesAll(jobBlock(publication, 'summary'), [/needs: publish/, /if: always\(\)/, /ci-quality-summary@/]);
});

// integration_id: package-publication-workflow-contract
test('package workflows preserve failed and unknown outcomes', () => {
  includesAll(jobBlock(read('workflows/package/package-publication-request.yml'), 'summary'), [/if: always\(\)/, /"rawResult":"\$\{\{ needs\.request\.result \}\}"/]);
  includesAll(jobBlock(read('workflows/package/package-publication-caller.yml'), 'summary'), [/if: always\(\)/, /"rawResult":"\$\{\{ needs\.publish\.result \}\}"/]);
});

// integration_id: repository-quality-delivery-regression
test('repository quality workflow scopes branch events and cancels only stale PR runs', () => {
  const workflow = read('.github/workflows/quality-gate.yml');
  assert.match(workflow, /^  push:\n    branches: \[main, develop, 'release\/\*\*', 'hotfix\/\*\*'\]$/m);
  assert.match(workflow, /^  pull_request:\n    branches: \[main, develop, 'release\/\*\*', 'hotfix\/\*\*'\]$/m);
  assert.match(
    workflow,
    /^  group: quality-gate-\$\{\{ github\.workflow \}\}-\$\{\{ github\.event_name == 'pull_request' && format\('pr-\{0\}', github\.event\.pull_request\.number\) \|\| format\('run-\{0\}', github\.run_id\) \}\}$/m,
  );
  assert.match(workflow, /^  cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}$/m);
});

// integration_id: repository-quality-delivery-regression
test('repository quality workflow keeps the required hosted check behind Linux and Windows evidence', () => {
  const workflow = read('.github/workflows/quality-gate.yml');
  const linux = jobBlock(workflow, 'contract-linux');
  const windows = jobBlock(workflow, 'rust-windows');
  const aggregate = jobBlock(workflow, 'contract');
  assert.match(linux, /^    name: CI Action contract \/ Linux$/m);
  includesAll(windows, [
    /^    name: Rust release contract \/ Windows$/m,
    /^    runs-on: windows-2025$/m,
    /--test-name-pattern="PowerShell\|Windows"/,
  ]);
  assert.deepEqual(new Set(summaryNeeds(aggregate)), new Set(['contract-linux', 'rust-windows']));
  includesAll(aggregate, [
    /^    name: CI Action contract \/ hosted$/m,
    /^    if: always\(\)$/m,
    /test "\$LINUX_RESULT" = success/,
    /test "\$WINDOWS_RESULT" = success/,
  ]);
});

// integration_id: repository-quality-delivery-regression
test('repository workflow provider actions use registry-approved pins', () => {
  const registry = read('skills/ci-github/references/ci-github-preset-assets.reference.yml');
  for (const relative of ['.github/workflows/quality-gate.yml', '.github/workflows/release.yml']) {
    const workflow = read(relative);
    const external = [...workflow.matchAll(/uses: ([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)@([0-9a-f]{40})/g)]
      .map(([, action, sha]) => ({ action, sha }));
    assert.ok(external.length > 0, `${relative} must pin external provider actions`);
    for (const { action, sha } of external) {
      const escaped = action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert.match(
        registry,
        new RegExp(`\\baction: ${escaped}\\b[^\\n]*\\bcommitSha: ${sha}\\b`),
        `${relative} uses ${action}@${sha} without a matching registry approval`,
      );
    }
  }
});

// integration_id: repository-quality-delivery-regression
test('repository gate Action steps match their action.yml inputs', () => {
  const job = jobBlock(read('.github/workflows/quality-gate.yml'), 'contract-linux');
  const actionInputs = (name) => {
    const inputsSection = read(`actions/${name}/action.yml`).split(/^inputs:\s*$/m)[1];
    if (!inputsSection) return [];
    return inputsSection.split(/^\S/m)[0]
      .split(/^  (?=[a-zA-Z0-9_-]+:)/m)
      .filter((entry) => /^([a-zA-Z0-9_-]+):/.test(entry))
      .map((entry) => ({
        name: entry.match(/^([a-zA-Z0-9_-]+):/)[1],
        required: /^    required:\s*true\s*$/m.test(entry),
      }));
  };
  let checked = 0;
  let direct = 0;
  for (const step of job.split('\n      - ').slice(1)) {
    const useMatch = step.match(/^        uses: \.\/actions\/([a-zA-Z0-9_-]+)$/m);
    const runMatch = step.match(/\bnode actions\/([a-zA-Z0-9_-]+)\/dist\/index\.js\b/);
    const action = useMatch?.[1] ?? runMatch?.[1];
    if (!action) continue;
    const stepName = step.match(/^        name: (.+)$/m)?.[1] ?? action;
    const declared = actionInputs(action);
    const provided = useMatch
      ? [...(step.split(/^        with:\s*$/m)[1] ?? '').split(/^        \S/m)[0]
          .matchAll(/^          ([a-zA-Z0-9_-]+):/gm)].map((match) => match[1])
      : [...(step.split(/^        env:\s*$/m)[1] ?? '').split(/^        \S/m)[0]
          .matchAll(/^          INPUT_([A-Z0-9_-]+):/gm)].map((match) => match[1].toLowerCase());
    const declaredNames = declared.map((input) => input.name);
    for (const input of provided) {
      assert.ok(declaredNames.includes(input), `${stepName} passes undeclared input ${input} to ${action}`);
    }
    for (const input of declared) {
      if (input.required) {
        assert.ok(provided.includes(input.name), `${stepName} omits required input ${input.name} of ${action}`);
      }
    }
    if (runMatch) direct += 1;
    checked += 1;
  }
  assert.ok(checked > 0, 'expected the repository gate to use local Action steps');
  assert.ok(direct > 0, 'expected the repository gate to validate direct Action invocations');
});

// integration_id: repository-quality-delivery-regression
test('canonical workflow summaries cover exactly their needs jobs', () => {
  const workflows = [
    ['workflows/quality/quality-gate.yml', 'summary'],
    ['workflows/release/release-request-tag.yml', 'summary'],
    ['workflows/release/release-publication-request.yml', 'summary'],
    ['workflows/release/release-publication-caller.yml', 'summary'],
    ['workflows/release/release-publication.yml', 'summary'],
    ['workflows/package/package-publication-request.yml', 'summary'],
    ['workflows/package/package-publication-caller.yml', 'summary'],
    ['workflows/package/package-preparation.yml', 'summary'],
    ['workflows/package/package-publication.yml', 'summary'],
  ];
  for (const [relative, summaryId] of workflows) {
    const summary = jobBlock(read(relative), summaryId);
    const needs = summaryNeeds(summary);
    const rows = [...summary.matchAll(/"rawResult":"\$\{\{ needs\.([a-zA-Z0-9_-]+)\.result \}\}"/g)]
      .map(([, job]) => job);
    assert.deepEqual([...rows].sort(), [...needs].sort(), `${relative} summary rows must match needs`);
    assert.equal(new Set(rows).size, rows.length, `${relative} summary rows must be unique`);
  }
});

// integration_id: failure-diagnostics-contract
test('managed workflows expose correlated secret-safe failure evidence without hiding source results', () => {
  const workflows = [
    ['workflows/quality/quality-gate.yml', 'summary'],
    ['workflows/quality/quality-gate-platforms.yml', 'platform-summary'],
    ['workflows/release/release-request-tag.yml', 'summary'],
    ['workflows/release/release-publication-request.yml', 'summary'],
    ['workflows/release/release-publication-caller.yml', 'summary'],
    ['workflows/release/release-publication.yml', 'summary'],
    ['workflows/package/package-publication-request.yml', 'summary'],
    ['workflows/package/package-publication-caller.yml', 'summary'],
    ['workflows/package/package-preparation.yml', 'summary'],
    ['workflows/package/package-publication.yml', 'summary'],
  ];
  for (const [relative, summaryId] of workflows) {
    const summary = jobBlock(read(relative), summaryId);
    includesAll(summary, [
      /^    if: always\(\)$/m,
      /ci-quality-summary@/,
      /^      WORKFLOW_RUN_URL: \$\{\{ github\.server_url \}\}\/\$\{\{ github\.repository \}\}\/actions\/runs\/\$\{\{ github\.run_id \}\}$/m,
      /"evidence"/,
      /"reason"/,
    ]);
    assert.doesNotMatch(summary, /secrets(?:\.|\s*\[)/);

    if (summaryId === 'platform-summary') {
      includesAll(summary, [
        /^      RESOLVE_RESULT: \$\{\{ needs\.resolve-platforms\.result \}\}$/m,
        /^      PLATFORM_RESULT: \$\{\{ needs\.platform\.result \}\}$/m,
        /elif \[\[ "\$\{RESOLVE_RESULT:-\}" == "success" && "\$\{PLATFORM_RESULT:-\}" == "success" \]\]; then\n\s+result="success"/,
        /elif \[\[ "\$\{PLATFORM_RESULT:-\}" == "failure" \|\| "\$\{RESOLVE_RESULT:-\}" == "failure" \]\]; then\n\s+result="failed"/,
        /elif \[\[ "\$\{PLATFORM_RESULT:-\}" == "cancelled" \|\| "\$\{PLATFORM_RESULT:-\}" == "skipped" \]\]; then\n\s+result="未実施"/,
        /else\n\s+result="判定不能"/,
        /"evidence": os\.environ\["EVIDENCE"\]/,
        /"reason": os\.environ\["REASON"\]/,
      ]);
      continue;
    }

    for (const sourceJob of summaryNeeds(summary)) {
      const record = unitRecord(summary, sourceJob);
      const escapedJob = sourceJob.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // The row passes the raw GitHub job result and caller-owned applicability;
      // failed and missing states are normalized by the ci-quality-summary contract.
      assert.match(record, new RegExp(`"rawResult":"\\$\\{\\{ needs\\.${escapedJob}\\.result \\}\\}"`));
      assert.match(record, /"applicable":/);
      assert.match(record, /"evidence":"\$\{\{ env\.WORKFLOW_RUN_URL \}\}"/);
      assert.match(record, new RegExp(`"reason":"[^"]*needs\\.${escapedJob}\\.result`));
    }
  }
});
