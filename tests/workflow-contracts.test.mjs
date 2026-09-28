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
    /^        uses: a3-suite\/a3-actions\/actions\/ci-quality-adapter@3b705bcbb0286a9da0f3bdb73f39d58043ca5605$/m,
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
    /^        uses: a3-suite\/a3-actions\/actions\/ci-quality-adapter@3b705bcbb0286a9da0f3bdb73f39d58043ca5605$/m,
    /^          bundle-path: \.ci-base\/\$\{\{ env\.CI_ADAPTER_DESCRIPTOR \}\}$/m,
  ]);
  includesAll(jobBlock(workflow, 'summary'), [/needs: \[trusted, untrusted-pr\]/, /if: always\(\)/, /uses: a3-suite\/a3-actions\/actions\/ci-quality-summary@/]);
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
  ]);
  includesAll(jobBlock(workflow, 'platform'), [
    /needs: resolve-platforms/,
    /matrix: .*needs\.resolve-platforms\.outputs\.matrix/,
    /trusted-project-root: .*trusted_root/,
    /uses: a3-suite\/a3-actions\/actions\/ci-quality-adapter@/,
  ]);
  includesAll(jobBlock(workflow, 'platform-summary'), [
    /needs: \[resolve-platforms, platform\]/,
    /if: always\(\)/,
    /EXPECTED_PLATFORMS/,
    /uses: a3-suite\/a3-actions\/actions\/ci-quality-summary@/,
  ]);
});

// integration_id: quality-workflow-contract
test('quality workflow keeps failed or missing checks visible', () => {
  const summary = jobBlock(read('workflows/quality/quality-gate.yml'), 'summary');
  includesAll(summary, [/if: always\(\)/, /needs\..*\.result/, /判定不能/, /未実施/]);
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
  includesAll(summary, [/if: always\(\)/, /ci-quality-summary@/, /request job result:/, /failed/]);
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
  includesAll(jobBlock(caller, 'publish'), [/needs: validate-request/, /contents: write/, /uses: \.\/\.github\/workflows\/release-publication\.yml/]);
  includesAll(jobBlock(caller, 'summary'), [/needs: \[validate-request, publish\]/, /if: always\(\)/, /ci-quality-summary@/]);
  assert.match(publication, /workflow_call:/);
  includesAll(jobBlock(publication, 'authority'), [/Verify workflow identity/, /Verify publication request workflow run/]);
  includesAll(jobBlock(publication, 'build'), [/needs: \[authority, source-gate, quality\]/]);
  includesAll(jobBlock(publication, 'publish'), [/needs: \[authority, assemble\]/, /contents: write/]);
  includesAll(jobBlock(publication, 'summary'), [/needs: \[authority, source-gate, quality, build, supplemental-asset, assemble, publish\]/, /if: always\(\)/, /ci-quality-summary@/]);
});

// integration_id: release-publication-workflow-contract
test('release publication workflows preserve failed and unknown outcomes', () => {
  includesAll(jobBlock(read('workflows/release/release-publication-request.yml'), 'summary'), [/if: always\(\)/, /failed/, /判定不能/]);
  includesAll(jobBlock(read('workflows/release/release-publication-caller.yml'), 'summary'), [/if: always\(\)/, /failed/, /判定不能/]);
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
  includesAll(jobBlock(caller, 'prepare'), [/needs: validate-request/, /uses: \.\/\.github\/workflows\/package-preparation\.yml/]);
  includesAll(jobBlock(caller, 'publish'), [/needs: \[validate-request, prepare\]/, /packages: write/, /uses: \.\/\.github\/workflows\/package-publication\.yml/]);
  includesAll(jobBlock(caller, 'summary'), [/needs: \[validate-request, prepare, publish\]/, /if: always\(\)/, /ci-quality-summary@/]);
  assert.match(preparation, /workflow_call:/);
  assert.match(jobBlock(preparation, 'build'), /needs: version-plan/);
  assert.match(publication, /workflow_call:/);
  includesAll(jobBlock(publication, 'publish'), [/packages: write/]);
  includesAll(jobBlock(publication, 'summary'), [/needs: publish/, /if: always\(\)/, /ci-quality-summary@/]);
});

// integration_id: package-publication-workflow-contract
test('package workflows preserve failed and unknown outcomes', () => {
  includesAll(jobBlock(read('workflows/package/package-publication-request.yml'), 'summary'), [/if: always\(\)/, /failed/, /判定不能/]);
  includesAll(jobBlock(read('workflows/package/package-publication-caller.yml'), 'summary'), [/if: always\(\)/, /failed/, /判定不能/]);
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
      assert.match(record, new RegExp(`needs\\.${escapedJob}\\.result == 'success' && 'success'`));
      assert.match(record, new RegExp(`needs\\.${escapedJob}\\.result == 'failure' && 'failed'`));
      assert.match(record, new RegExp(
        `needs\\.${escapedJob}\\.result == 'cancelled' \\|\\| needs\\.${escapedJob}\\.result == 'skipped'\\) && '未実施'`,
      ));
      assert.match(record, /\|\| '判定不能'/);
      assert.match(record, /"evidence":"\$\{\{ env\.WORKFLOW_RUN_URL \}\}"/);
      assert.match(record, new RegExp(`"reason":"[^"]*needs\\.${escapedJob}\\.result`));
    }
  }
});
