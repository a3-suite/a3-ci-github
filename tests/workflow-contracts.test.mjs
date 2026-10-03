import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'vitest';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');
const yaml = createRequire(import.meta.url)(path.join(root, 'runtime/preset/node_modules/yaml'));

// integration_id: quality-workflow-contract
test('quality caller passes explicit inputs and preserves the summary check without copying quality jobs', () => {
  const caller = yaml.parse(read('workflows/quality/quality-gate.yml'));
  const callee = yaml.parse(read('.github/workflows/ci-quality.yml'));
  assert.deepEqual(Object.keys(caller.jobs), ['quality', 'summary']);
  assert.equal(caller.env, undefined);
  assert.equal(caller.jobs.quality.steps, undefined);
  assert.equal(caller.jobs.quality.secrets, undefined);
  assert.equal(caller.jobs.quality.permissions.contents, 'read');
  assert.equal(caller.jobs.quality.uses, 'a3-suite/a3-ci-github/.github/workflows/ci-quality.yml@<quality-workflow-sha>');
  assert.deepEqual(Object.keys(caller.jobs.quality.with).sort(), Object.keys(callee.on.workflow_call.inputs).sort());
  assert.deepEqual(Object.keys(callee.on), ['workflow_call']);
  assert.equal(callee.on.workflow_call.secrets, undefined);
  assert.equal(callee.concurrency, undefined);
  assert.equal(caller.jobs.summary.needs, 'quality');
  assert.equal(caller.jobs.summary.if, 'always()');
  assert.equal(caller.jobs.summary.name, undefined);
  assert.deepEqual(Object.keys(callee.jobs), ['trusted', 'untrusted-pr', 'summary']);
  assert.equal(callee.on.workflow_call.inputs['jq-version'].required, false);
  assert.equal(callee.on.workflow_call.inputs['jq-version'].default, '');
  for (const id of ['trusted', 'untrusted-pr']) {
    const steps = callee.jobs[id].steps;
    const jqSteps = steps.filter((step) => /actions\/ci-(?:jq-provisioner|github-toolchain-verifier)@/.test(step.uses ?? ''));
    assert.equal(jqSteps.length, 2);
    for (const step of jqSteps) {
      assert.equal(step.if, "steps.change-scope.outputs['run-ci'] != 'false' && env.CI_JQ_VERSION != ''");
      assert.equal(step.with['jq-version'], '${{ env.CI_JQ_VERSION }}');
    }
    for (const step of steps.filter((step) => /actions\/ci-quality-(?:toolchain|adapter)@/.test(step.uses ?? ''))) {
      assert.equal(step.if, "steps.change-scope.outputs['run-ci'] != 'false'");
    }
  }
});

// integration_id: quality-workflow-contract
test('caller summary rejects failed cancelled skipped and missing reusable results through the bundled Action', () => {
  const templates = [
    ['workflows/quality/quality-gate.yml', 'summary', 'quality'],
    ['workflows/quality/quality-gate-platforms.yml', 'platform-summary', 'platforms'],
  ].map(([file, job, source]) => ({ source, template: yaml.parse(read(file)).jobs[job].steps.find((step) => step.with?.['summary-json']).with['summary-json'] }));
  mkdirSync(path.join(root, 'tmp'), { recursive: true });
  const directory = mkdtempSync(path.join(root, 'tmp/reusable-quality-summary-'));
  try {
    for (const { source, template } of templates) for (const result of ['success', 'failure', 'cancelled', 'skipped', '', 'unknown']) {
      const payload = template.replaceAll('${{ needs.' + source + '.result }}', result).replaceAll('${{ env.WORKFLOW_RUN_URL }}', 'https://github.com/example/project/actions/runs/1');
      const run = spawnSync(process.execPath, [path.join(root, 'actions/ci-quality-summary/dist/index.js')], {
        cwd: directory, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true',
          'INPUT_SUMMARY-JSON': payload, 'INPUT_SUMMARY-PATH': path.join(directory, 'summary.md'),
          'INPUT_EVIDENCE-PATH': path.join(directory, 'evidence.md'),
        },
      });
      assert.equal(run.status === 0, result === 'success', `${result}: ${run.stderr}`);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

// integration_id: quality-workflow-contract
test('canonical quality bootstrap scripts preserve standard custom and fork boundaries', () => {
  const lock = '.ci-base/.ci/ci-assets.lock.json';
  const descriptor = '.ci-base/.ci/adapters/custom.yml';
  const platforms = ['.ci-base/.ci/platform-manifest.yml', '.ci-base/.ci/quality-platforms.yml'];
  for (const [file, job, assets] of [
    ['.github/workflows/ci-quality.yml', 'trusted', []],
    ['.github/workflows/ci-quality-platforms.yml', 'resolve-platforms', platforms],
  ]) {
    const script = yaml.parse(read(file)).jobs[job].steps.find((step) => step.id === 'trusted-assets').run;
    const cases = [
      { files: [lock, ...assets], custom: false, same: false, status: 0, root: '.ci-base' },
      { files: [lock, ...assets, descriptor], custom: true, same: false, status: 0, root: '.ci-base' },
      { files: [lock, ...assets], custom: true, same: true, status: 1 },
      { files: [], custom: false, same: true, status: 0, root: '.' },
      { files: [], custom: false, same: false, status: 1 },
      { files: [descriptor, ...assets], custom: true, same: true, status: 1 },
    ];
    if (assets.length) cases.push({ files: [lock, assets[0]], custom: false, same: true, status: 1 });
    for (const scenario of cases) {
      mkdirSync(path.join(root, 'tmp'), { recursive: true });
      const directory = mkdtempSync(path.join(root, 'tmp/quality-bootstrap-'));
      try {
        for (const relative of scenario.files) {
          mkdirSync(path.dirname(path.join(directory, relative)), { recursive: true });
          writeFileSync(path.join(directory, relative), '{}');
        }
        const output = path.join(directory, 'output');
        const result = spawnSync('bash', ['-c', script], {
          cwd: directory, encoding: 'utf8', env: { ...process.env,
            CI_ADAPTER_DESCRIPTOR: scenario.custom ? '.ci/adapters/custom.yml' : '',
            CI_PLATFORM_MANIFEST: '.ci/platform-manifest.yml',
            CI_QUALITY_PLATFORM_SELECTION: '.ci/quality-platforms.yml',
            CI_SAME_REPO: String(scenario.same), GITHUB_OUTPUT: output,
          },
        });
        assert.equal(result.status, scenario.status, `${file}: ${JSON.stringify(scenario)}: ${result.stderr}`);
        if (scenario.status === 0) assert.ok(readFileSync(output, 'utf8').split('\n').includes(`root=${scenario.root}`));
      } finally { rmSync(directory, { recursive: true, force: true }); }
    }
  }
});
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
  const workflow = read('.github/workflows/ci-quality.yml').replaceAll('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', 'actions/checkout@<commit-sha>');
  includesAll(workflow, [/workflow_call:/, /permissions:\n  contents: read/]);
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
    /^        uses: a3-suite\/a3-ci-github\/actions\/ci-quality-adapter@<release-publication-action-sha>$/m,
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
    /^        uses: a3-suite\/a3-ci-github\/actions\/ci-quality-adapter@<release-publication-action-sha>$/m,
    /^          standard-bundle-id: \$\{\{ env\.CI_STANDARD_BUNDLE_ID \}\}$/m,
  ]);
  const summary = jobBlock(workflow, 'summary');
  assertNeeds(summary, ['trusted', 'untrusted-pr']);
  includesAll(summary, [/if: always\(\)/, /uses: a3-suite\/a3-ci-github\/actions\/ci-quality-summary@/]);
  const main = yaml.parse(workflow).jobs;
  const platforms = yaml.parse(read('.github/workflows/ci-quality-platforms.yml')).jobs;
  const baseCheckout = (job) => job.steps.find((step) => step.name === 'Checkout trusted CI assets');
  const resolver = main.trusted.steps.find((step) => step.id === 'trusted-assets');
  const standardBundles = JSON.parse(read('runtime/adapter/standard-quality-bundles.generated.ts')
    .match(/^export const STANDARD_QUALITY_BUNDLES = (\[[\s\S]*\]) as const;$/m)[1]);
  // Evaluate only the lowercase string comparisons and boolean operators exercised by these fixtures.
  const selected = (step, id, descriptor = '', runCi = 'true', root = '.ci-base') => runInNewContext(
    step.if.replaceAll('steps.change-scope', "steps['change-scope']").replaceAll('needs.resolve-platforms', "needs['resolve-platforms']"),
    { env: { CI_STANDARD_BUNDLE_ID: id, CI_ADAPTER_DESCRIPTOR: descriptor },
      steps: { 'change-scope': { outputs: { 'run-ci': runCi } } },
      needs: { 'resolve-platforms': { outputs: { trusted_root: root } } } },
  );
  for (const [id, descriptor, required] of [
    ['rust-cargo-quality', '', false], ['python-uv-quality', '', false],
    ['typescript-npm-quality', '', true], ['', '.ci/adapters/custom.yml', true],
    ['rust-cargo-quality', '.ci/adapters/custom.yml', true], ['unknown', '', true],
  ]) {
    assert.equal(selected(baseCheckout(main.trusted), id, descriptor), required, `${id}: trusted checkout`);
    assert.equal(selected(resolver, id, descriptor), required, `${id}: trusted resolver`);
    assert.equal(selected(baseCheckout(main['untrusted-pr']), id, descriptor), descriptor !== '', `${id}: fork checkout`);
    assert.equal(selected(baseCheckout(platforms.platform), id, descriptor), required, `${id}: platform checkout`);
    assert.equal(selected(baseCheckout(platforms.platform), id, descriptor, 'true', '.'), false, `${id}: platform bootstrap`);
    assert.equal(selected(baseCheckout(main.trusted), id, descriptor, 'false'), false, `${id}: docs-only checkout`);
    assert.equal(selected(resolver, id, descriptor, 'false'), false, `${id}: docs-only resolver`);
    assert.equal(selected(baseCheckout(main['untrusted-pr']), id, descriptor, 'false'), false, `${id}: docs-only fork`);
    if (!required) {
      const bundle = standardBundles.find((entry) => entry.id === id);
      assert.deepEqual(yaml.parse(bundle.descriptor).projectSettings.requiredScripts, [], `${id}: skipped trusted root must remain unused`);
    }
  }
  assert.equal(baseCheckout(platforms['resolve-platforms']).if, undefined, 'manifest and selection resolution still require base assets');
});

// integration_id: quality-workflow-contract
test('platform caller passes explicit inputs and retains the summary identity', () => {
  const caller = yaml.parse(read('workflows/quality/quality-gate-platforms.yml'));
  const callee = yaml.parse(read('.github/workflows/ci-quality-platforms.yml'));
  assert.deepEqual(Object.keys(caller.jobs), ['platforms', 'platform-summary']);
  assert.equal(caller.env, undefined);
  assert.equal(caller.jobs.platforms.steps, undefined);
  assert.equal(caller.jobs.platforms.secrets, undefined);
  assert.deepEqual(caller.jobs.platforms.permissions, { contents: 'read' });
  assert.equal(caller.jobs.platforms.uses, 'a3-suite/a3-ci-github/.github/workflows/ci-quality-platforms.yml@<quality-platforms-workflow-sha>');
  assert.deepEqual(Object.keys(caller.jobs.platforms.with).sort(), Object.keys(callee.on.workflow_call.inputs).sort());
  assert.deepEqual(Object.keys(callee.on), ['workflow_call']);
  assert.equal(callee.on.workflow_call.secrets, undefined);
  assert.equal(callee.concurrency, undefined);
  assert.equal(caller.jobs['platform-summary'].name, 'quality-gate-platforms / summary');
  assert.notEqual(callee.jobs['platform-summary'].name, caller.jobs['platform-summary'].name);
  assert.equal(caller.jobs['platform-summary'].needs, 'platforms');
  assert.equal(caller.jobs['platform-summary'].if, 'always()');
  assert.deepEqual(Object.keys(callee.jobs), ['resolve-platforms', 'platform', 'platform-summary']);
});

// integration_id: quality-workflow-contract
test('platform summary scripts preserve docs-only failed cancelled and missing outcomes', () => {
  const summary = yaml.parse(read('.github/workflows/ci-quality-platforms.yml')).jobs['platform-summary'];
  const enforce = summary.steps.find((step) => step.name === 'Enforce required platform results').run;
  const build = summary.steps.find((step) => step.id === 'platform-summary').run;
  const cases = [
    ['success', 'success', 'true', 'linux-x64', 'success', true],
    ['success', 'success', 'true', 'linux-x64,macos-arm64', 'success', true],
    ['success', 'failure', 'true', 'linux-x64,macos-arm64', 'failed', false],
    ['success', 'skipped', 'false', 'linux-x64,macos-arm64', 'success', true],
    ['failure', 'skipped', 'false', 'linux-x64', 'failed', false],
    ['success', 'failure', 'true', 'linux-x64', 'failed', false],
    ['success', 'cancelled', 'true', 'linux-x64', '未実施', false],
    ['success', 'skipped', 'true', 'linux-x64', '未実施', false],
    ['success', '', 'true', 'linux-x64', '判定不能', false],
    ['', '', '', '', '判定不能', false],
    ['success', 'skipped', 'false', '', 'failed', false],
  ];
  mkdirSync(path.join(root, 'tmp'), { recursive: true });
  const directory = mkdtempSync(path.join(root, 'tmp/platform-summary-'));
  try {
    for (const [resolve, platform, runCi, expected, status, accepted] of cases) {
      const output = path.join(directory, 'output');
      writeFileSync(output, '');
      const env = { ...process.env, RESOLVE_RESULT: resolve, PLATFORM_RESULT: platform,
        RUN_CI: runCi, EXPECTED_PLATFORMS: expected, WORKFLOW_RUN_URL: 'https://github.com/example/project/actions/runs/1', GITHUB_OUTPUT: output };
      const enforcement = spawnSync('bash', ['-c', enforce], { cwd: directory, env, encoding: 'utf8' });
      const result = spawnSync('bash', ['-c', build], { cwd: directory, env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      const payload = readFileSync(output, 'utf8').trim().slice('summary='.length);
      const records = JSON.parse(payload).jobs;
      assert.equal(records[0].result, status);
      assert.equal(records[0].evidence, env.WORKFLOW_RUN_URL);
      if (accepted && runCi === 'true') assert.equal(records[0].reason, `all selected platforms succeeded: ${expected}`);
      if (accepted && runCi === 'false') assert.deepEqual(records.slice(1).map((entry) => [entry.unit, entry.result]), [['platform:linux-x64', '対象外'], ['platform:macos-arm64', '対象外']]);
      const action = spawnSync(process.execPath, [path.join(root, 'actions/ci-quality-summary/dist/index.js')], {
        cwd: directory, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true', 'INPUT_SUMMARY-JSON': payload,
          'INPUT_SUMMARY-PATH': path.join(directory, 'summary.md'), 'INPUT_EVIDENCE-PATH': path.join(directory, 'evidence.md') },
      });
      assert.equal(enforcement.status === 0 && action.status === 0, accepted, JSON.stringify({ resolve, platform, runCi, expected }));
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

// integration_id: quality-workflow-contract
test('optional platform quality workflow preserves trusted assets matrix execution and summary', () => {
  const workflow = read('.github/workflows/ci-quality-platforms.yml');
  const resolve = jobBlock(workflow, 'resolve-platforms');
  includesAll(resolve, [
    /id: trusted-assets/,
    /pull_request\.base\.sha/,
    /matrix: .*steps\.resolve\.outputs\['quality-matrix'\]/,
    /expected: .*steps\.resolve\.outputs\['expected-platforms'\]/,
    /uses: a3-suite\/a3-ci-github\/actions\/ci-platform-matrix@<release-publication-action-sha>/,
    /manifest-path: .*steps\.trusted-assets\.outputs\.root.*env\.CI_PLATFORM_MANIFEST/,
    /selection-path: .*steps\.trusted-assets\.outputs\.root.*env\.CI_QUALITY_PLATFORM_SELECTION/,
    /bootstrap is limited to same-repository pull requests/,

  ]);
  assert.doesNotMatch(resolve, /CoreLoader|PyYAML|pyyaml|Set up uv|uv run/);
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
  const summary = jobBlock(read('.github/workflows/ci-quality.yml'), 'summary');
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
  assert.doesNotMatch(workflow, /CI_(?:GH|JQ|SHA256SUM)_VERSION|ci-(?:gh-provisioner|jq-provisioner|github-toolchain-verifier)@/);
  includesAll(jobBlock(workflow, 'summary'), [/needs: request/, /if: always\(\)/, /ci-quality-summary@/]);
});

// integration_id: release-request-workflow-contract
test('release request workflow reports handoff failure in its summary', () => {
  const summary = jobBlock(read('workflows/release/release-request-tag.yml'), 'summary');
  includesAll(summary, [/if: always\(\)/, /ci-quality-summary@/, /request job result:/, /"rawResult":"\$\{\{ needs\.request\.result \}\}"/]);
});

const assertPublicationControl = (text, kind) => {
  const workflow = yaml.parse(text);
  const entryJob = kind === 'release' ? 'authority' : 'publish';
  const entry = workflow.jobs[entryJob].steps[0];
  assert.equal(entry.id, 'publication-entry');
  assert.deepEqual(entry.env, {
    REPOSITORY: '${{ github.repository }}',
    DEFAULT_BRANCH: '${{ github.event.repository.default_branch }}',
    CALLER_EVENT: '${{ github.event_name }}',
    CALLER_WORKFLOW_REF: '${{ github.workflow_ref }}',
    CONTROL_SHA: '${{ github.workflow_sha }}',
  });
  assert.doesNotMatch(text, /ci-workflow-identity@|job\.workflow_|steps\.workflow-identity|control_sha:/);
  const valid = {
    REPOSITORY: 'example/consumer', DEFAULT_BRANCH: 'main', CALLER_EVENT: 'workflow_run',
    CALLER_WORKFLOW_REF: `example/consumer/.github/workflows/${kind}-publication-caller.yml@refs/heads/main`,
    CONTROL_SHA: 'a'.repeat(40),
  };
  const run = (env) => spawnSync('bash', ['-c', entry.run], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  assert.equal(run(valid).status, 0);
  for (const [field, values] of Object.entries({
    REPOSITORY: ['', 'other/consumer'], DEFAULT_BRANCH: ['', 'feature'],
    CALLER_EVENT: ['workflow_dispatch', 'push', 'pull_request'],
    CALLER_WORKFLOW_REF: ['', `other/consumer/.github/workflows/${kind}-publication-caller.yml@refs/heads/main`, `example/consumer/.github/workflows/other.yml@refs/heads/main`, `example/consumer/.github/workflows/${kind}-publication-caller.yml@refs/tags/v1`, '$(exit 0)'],
    CONTROL_SHA: ['', 'main', 'a'.repeat(39), 'A'.repeat(40), '$(exit 0)'],
  })) for (const value of values) assert.notEqual(run({ ...valid, [field]: value }).status, 0, `${kind}: ${field}=${value}`);
  const controlJobs = kind === 'release' ? ['authority', 'quality', 'assemble', 'publish'] : ['publish'];
  for (const jobName of controlJobs) {
    const job = workflow.jobs[jobName];
    if (jobName !== entryJob) {
      assert.ok([job.needs].flat().includes('authority'));
      if (job.if !== undefined) assert.match(job.if, /needs\.authority\.result == 'success'/);
      assert.equal(job.steps.some(step => step.id === 'publication-entry'), false);
    }
    const index = job.steps.findIndex(step => step.uses?.startsWith('actions/checkout@') && step.with?.ref === '${{ github.workflow_sha }}');
    assert.ok(index >= 0);
    assert.equal(job.steps[index].with.repository, '${{ github.repository }}');
    const verification = job.steps[index + 1];
    assert.equal(verification.name, 'Verify trusted control checkout');
    assert.equal(verification.env.CONTROL_SHA, '${{ github.workflow_sha }}');
    const git = jobName === 'quality' ? 'git -C .ci-base' : 'git';
    assert.equal(verification.run, `test "$(${git} rev-parse HEAD)" = "$CONTROL_SHA"`);
  }
};

// integration_id: release-publication-workflow-contract
test('release publication workflows separate request validation from privileged publication', () => {
  const request = read('workflows/release/release-publication-request.yml');
  const caller = read('workflows/release/release-publication-caller.yml');
  const publication = read('.github/workflows/ci-release-publication.yml');
  assert.match(request, /workflow_dispatch:/);
  includesAll(jobBlock(request, 'request'), [/contents: read/, /operation: create-request/]);
  includesAll(jobBlock(request, 'summary'), [/needs: request/, /if: always\(\)/, /ci-quality-summary@/]);
  assert.match(caller, /workflow_run:/);
  includesAll(jobBlock(caller, 'validate-request'), [/actions: read/, /contents: read/, /operation: verify-publication-request/]);
  const callerPublish = jobBlock(caller, 'publish');
  assertNeeds(callerPublish, ['validate-request']);
  includesAll(callerPublish, [/contents: write/, /uses: a3-suite\/a3-ci-github\/\.github\/workflows\/ci-release-publication\.yml@<release-publication-workflow-sha>/]);
  const callerSummary = jobBlock(caller, 'summary');
  assertNeeds(callerSummary, ['validate-request', 'publish']);
  includesAll(callerSummary, [/if: always\(\)/, /ci-quality-summary@/]);
  assert.match(publication, /workflow_call:/);
  assertPublicationControl(publication, 'release');
  const qualitySteps = yaml.parse(publication).jobs.quality.steps;
  const qualityAdapter = qualitySteps.find(step => step.id === 'quality-adapter');
  assert.equal(qualityAdapter.with['bundle-path'], "${{ env.CI_ADAPTER_DESCRIPTOR && format('.ci-base/{0}', env.CI_ADAPTER_DESCRIPTOR) || '' }}");
  assert.equal(qualityAdapter.with['require-trusted-project-scripts'], 'true');
  assert.equal(qualityAdapter.with['trusted-project-root'], '.ci-base');
  const qualityCheckout = qualitySteps.find(step => step.with?.path === '.ci-base');
  const qualityVerification = qualitySteps.find(step => step.name === 'Verify trusted control checkout');
  assert.equal(qualityCheckout.if, "env.CI_STANDARD_BUNDLE_ID != 'rust-cargo-quality' || env.CI_ADAPTER_DESCRIPTOR != ''");
  assert.equal(qualityVerification.if, qualityCheckout.if);
  includesAll(jobBlock(publication, 'authority'), [/Verify publication entry/, /Verify publication request workflow run/]);
  const buildJob = jobBlock(publication, 'build');
  assertNeeds(buildJob, ['authority', 'source-gate', 'quality']);
  includesAll(stepContaining(buildJob, '- name: Build and verify supplemental Release asset platform'), [
    /^        if: inputs\.supplemental_release_asset_enabled$/m,
    /actions\/ci-release-supplemental-asset@<release-publication-action-sha>/,
    /^          operation: build-platform$/m,
    /^          standard-build-root: build\/\$\{\{ matrix\.id \}\}$/m,
    /^          output-directory: supplemental-build\/\$\{\{ matrix\.id \}\}$/m,
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
    /actions\/ci-release-supplemental-asset@<release-publication-action-sha>/,
    /^          operation: assemble$/m,
    /^          standard-build-root: build$/m,
    /^          supplemental-build-root: supplemental-build$/m,
    /^          output-directory: supplemental-asset$/m,
  ]);
  assert.doesNotMatch(publication, /run: \.ci\/scripts\/ci-release-supplemental-asset\.sh/);
  const publicationJob = jobBlock(publication, 'publish');
  assertNeeds(publicationJob, ['authority', 'assemble']);
  assert.match(publicationJob, /contents: write/);
  assert.ok(stepIndexContaining(publicationJob, '- name: Verify trusted control checkout') < stepIndexContaining(publicationJob, '- name: Validate release handoff integrity'));
  assert.ok(stepIndexContaining(publicationJob, '- name: Validate release handoff integrity') < stepIndexContaining(publicationJob, '- name: Verify approval is still valid'));
  assert.ok(stepIndexContaining(publicationJob, '- name: Verify approval is still valid') < stepIndexContaining(publicationJob, '- id: publish'));
  assert.ok(stepIndexContaining(publicationJob, '- id: publish') < stepIndexContaining(publicationJob, '- name: Verify publication readback evidence'));
  assert.doesNotMatch(publicationJob.split(/^    steps:$/m)[0], /GH_TOKEN|CI_GITHUB_TOKEN/);
  includesAll(stepContaining(publicationJob, '- id: publish'), [/GH_TOKEN: \$\{\{ github\.token \}\}/, /ci-release-publisher@<release-publication-action-sha>/, /if: env.CI_RELEASE_IMPLEMENTATION == 'rust-cli-release'/]);
  assert.doesNotMatch(stepContaining(publicationJob, '- id: publish'), /ci-release-publish\.sh|CI_GITHUB_TOKEN/);
  includesAll(stepContaining(publicationJob, '- id: publish_owner'), [/if: env.CI_RELEASE_IMPLEMENTATION != 'rust-cli-release'/, /ci-release-publish\.sh/]);
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
  const preparation = read('.github/workflows/ci-package-preparation.yml');
  const publication = read('.github/workflows/ci-package-publication.yml');
  assert.match(request, /workflow_dispatch:/);
  includesAll(jobBlock(request, 'request'), [/permissions: \{\}/, /operation: create/]);
  includesAll(jobBlock(request, 'summary'), [/needs: request/, /if: always\(\)/, /ci-quality-summary@/]);
  assert.match(caller, /workflow_run:/);
  includesAll(jobBlock(caller, 'validate-request'), [/actions: read/, /operation: verify/]);
  const prepareJob = jobBlock(caller, 'prepare');
  assertNeeds(prepareJob, ['validate-request']);
  assert.match(prepareJob, /uses: a3-suite\/a3-ci-github\/\.github\/workflows\/ci-package-preparation\.yml@<package-preparation-workflow-sha>/);
  const publishJob = jobBlock(caller, 'publish');
  assertNeeds(publishJob, ['validate-request', 'prepare']);
  includesAll(publishJob, [/packages: write/, /uses: a3-suite\/a3-ci-github\/\.github\/workflows\/ci-package-publication\.yml@<package-publication-workflow-sha>/]);
  const callerSummary = jobBlock(caller, 'summary');
  assertNeeds(callerSummary, ['validate-request', 'prepare', 'publish']);
  includesAll(callerSummary, [/if: always\(\)/, /ci-quality-summary@/]);
  assert.match(preparation, /workflow_call:/);
  const preparationContract = yaml.parse(preparation);
  assert.deepEqual(Object.keys(preparationContract.on.workflow_call.inputs).sort(), ['language_profile', 'source_sha', 'target_identity', 'toolchain', 'version']);
  assert.ok(Object.values(preparationContract.on.workflow_call.inputs).every((input) => input.required === true && input.type === 'string'));
  assert.deepEqual(Object.keys(preparationContract.on.workflow_call.outputs).sort(), ['artifact_id', 'handoff_run_id', 'publish_version']);
  assert.deepEqual(preparationContract.permissions, {});
  assert.equal(preparationContract.on.workflow_call.secrets, undefined);
  assert.equal(preparationContract.concurrency, undefined);
  assert.deepEqual(preparationContract.jobs.build.permissions, { contents: 'read' });

  assert.match(jobBlock(preparation, 'build'), /needs: version-plan/);
  assert.match(publication, /workflow_call:/);
  assertPublicationControl(publication, 'package');
  const publicationJob = jobBlock(publication, 'publish');
  includesAll(publicationJob, [
    /packages: write/,
    /^      - name: Verify publication entry$/m,
    /CALLER_WORKFLOW_REF: \$\{\{ github\.workflow_ref \}\}/,
  ]);
  assert.ok(stepIndexContaining(publicationJob, '- name: Verify publication entry') < stepIndexContaining(publicationJob, '- name: Validate package handoff integrity'));
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
    /--testNamePattern="PowerShell\|Windows"/,
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
    ['workflows/quality/quality-gate-platforms.yml', 'platform-summary'],
    ['.github/workflows/ci-quality.yml', 'summary'],
    ['workflows/release/release-request-tag.yml', 'summary'],
    ['workflows/release/release-publication-request.yml', 'summary'],
    ['workflows/release/release-publication-caller.yml', 'summary'],
    ['.github/workflows/ci-release-publication.yml', 'summary'],
    ['workflows/package/package-publication-request.yml', 'summary'],
    ['workflows/package/package-publication-caller.yml', 'summary'],
    ['.github/workflows/ci-package-preparation.yml', 'summary'],
    ['.github/workflows/ci-package-publication.yml', 'summary'],
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
    ['.github/workflows/ci-quality.yml', 'summary'],
    ['workflows/quality/quality-gate-platforms.yml', 'platform-summary'],
    ['.github/workflows/ci-quality-platforms.yml', 'platform-summary'],
    ['workflows/release/release-request-tag.yml', 'summary'],
    ['workflows/release/release-publication-request.yml', 'summary'],
    ['workflows/release/release-publication-caller.yml', 'summary'],
    ['.github/workflows/ci-release-publication.yml', 'summary'],
    ['workflows/package/package-publication-request.yml', 'summary'],
    ['workflows/package/package-publication-caller.yml', 'summary'],
    ['.github/workflows/ci-package-preparation.yml', 'summary'],
    ['.github/workflows/ci-package-publication.yml', 'summary'],
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

    if (summaryId === 'platform-summary' && relative === '.github/workflows/ci-quality-platforms.yml') {
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

// integration_id: quality-workflow-contract
test('quality toolchain callers bind four inputs and preserve execution gates', () => {
  const pairs = [['.github/workflows/ci-quality.yml', 'trusted'], ['.github/workflows/ci-quality.yml', 'untrusted-pr'], ['.github/workflows/ci-quality-platforms.yml', 'platform'], ['.github/workflows/ci-release-publication.yml', 'quality']];
  const contract = yaml.parse(read('actions/ci-quality-toolchain/action.yml'));
  for (const [file, jobId] of pairs) {
    const workflow = yaml.parse(read(file));
    const job = workflow.jobs[jobId];
    const call = job.steps.filter((step) => step.uses?.includes('/actions/ci-quality-toolchain@'));
    assert.equal(call.length, 1, file);
    assert.equal(call[0].uses, 'a3-suite/a3-ci-github/actions/ci-quality-toolchain@<release-publication-action-sha>');
    assert.deepEqual(Object.keys(call[0].with).sort(), Object.keys(contract.inputs).sort());
    assert.deepEqual(call[0].with, { 'language-profile': '${{ env.CI_LANGUAGE_PROFILE }}', 'toolchain-version': '${{ env.CI_TOOLCHAIN_VERSION }}', 'uv-version': '${{ env.CI_UV_VERSION }}', 'cargo-audit-version': '${{ env.CI_CARGO_AUDIT_VERSION }}' });
    assert.equal(call[0].if, file.includes('ci-quality.yml') ? "steps.change-scope.outputs['run-ci'] != 'false'" : undefined);
    assert.equal(call[0]['continue-on-error'], undefined);
    assert.ok(job.steps.some((step) => step.uses?.includes('/actions/ci-quality-adapter@')));
    assert.ok(job.steps.every((step) => step.name !== 'Report project quality adapter result' && !step.env?.CI_QUALITY_RESULT_PATH));
    assert.ok(!job.steps.some((step) => step.run?.includes('rustup toolchain install') || step.uses?.startsWith('actions/setup-node@') || step.uses?.startsWith('actions/setup-python@') || step.uses?.startsWith('astral-sh/setup-uv@')));
  }
});
