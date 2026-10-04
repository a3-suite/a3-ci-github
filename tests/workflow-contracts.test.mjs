import { existsSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import yaml from 'yaml';
import path from 'node:path';
import { test, describe, expect } from 'vitest';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createDocsOnlyMatcher, detectChangeScope } from '../actions/ci-change-scope/src/scope.ts';
import { materializePublishVersion } from '../actions/ci-publish-version/src/materialize.ts';
import { resolveConfigSnapshot } from '../actions/ci-config-snapshot/src/snapshot.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');

describe("workflow-contracts", () => {
  describe("quality-workflow-contract", () => {
    // integration_id: quality-workflow-contract
    test('quality diff preparation fetches only the comparison commit and preserves fail-open scope', () => {
      // Arrange
      mkdirSync(path.join(root, 'tmp'), { recursive: true });
      const directory = mkdtempSync(path.join(root, 'tmp/quality-diff-'));
      const origin = path.join(directory, 'origin');
      mkdirSync(origin);
      const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      const headExpression = "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}";
      const baseExpression = "${{ github.event_name == 'pull_request' && github.event.pull_request.base.sha || github.event.before || '' }}";
      try {
        git(origin, 'init', '-b', 'topic');
        git(origin, 'config', 'user.name', 'CI fixture');
        git(origin, 'config', 'user.email', 'ci@example.invalid');
        writeFileSync(path.join(origin, 'README.md'), 'base\n');
        git(origin, 'add', '.'); git(origin, 'commit', '-m', 'base');
        const base = git(origin, 'rev-parse', 'HEAD');
        writeFileSync(path.join(origin, 'README.md'), 'documentation\n');
        git(origin, 'add', '.'); git(origin, 'commit', '-m', 'docs');
        const docsHead = git(origin, 'rev-parse', 'HEAD');
        writeFileSync(path.join(origin, 'main.mjs'), 'export const value = 1;\n');
        git(origin, 'add', '.'); git(origin, 'commit', '-m', 'source');
        const sourceHead = git(origin, 'rev-parse', 'HEAD');
        for (const [file, job] of [['.github/workflows/ci-quality.yml', 'trusted'], ['.github/workflows/ci-quality.yml', 'untrusted-pr'], ['.github/workflows/ci-quality-platforms.yml', 'resolve-platforms']]) {
          const steps = yaml.parse(read(file)).jobs[job].steps;
          const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout@'));
          const scope = steps.find((step) => step.id === 'change-scope');
          const preparation = steps.find((step) => step.name === 'Fetch comparison commit');
          expect(checkout.with.ref).toBe(headExpression);
          expect(scope.with['head-sha']).toBe(checkout.with.ref);
          expect(preparation, `${file}/${job}: comparison preparation missing`).toBeTruthy();
          expect(preparation.env.CI_DIFF_BASE_SHA).toBe(baseExpression);
          expect(steps.indexOf(checkout) < steps.indexOf(preparation) && steps.indexOf(preparation) < steps.indexOf(scope)).toBeTruthy();
          for (const [comparison, head, runCi] of [[base, docsHead, false], [base, sourceHead, true], ['1'.repeat(40), docsHead, true], ['0'.repeat(40), docsHead, true], ['', docsHead, true]]) {
            const consumer = mkdtempSync(path.join(directory, 'consumer-'));
            git(consumer, 'init'); git(consumer, 'remote', 'add', 'origin', `file://${origin}`);
            git(consumer, 'fetch', '--no-tags', '--depth=1', 'origin', head); git(consumer, 'checkout', '--detach', 'FETCH_HEAD');
            const before = spawnSync('git', ['cat-file', '-e', `${base}^{commit}`], { cwd: consumer });
            expect(before.status).not.toBe(0);
            const trace = path.join(consumer, 'fetch.trace');
            // Act
            const prepared = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', preparation.run], { cwd: consumer, encoding: 'utf8', env: { ...process.env, CI_DIFF_BASE_SHA: comparison, GIT_TRACE: trace } });
            const result = detectChangeScope(comparison, head, createDocsOnlyMatcher(['**/*.md']), (from, to) => execFileSync('git', ['diff', '--name-only', '-z', from, to], { cwd: consumer, encoding: 'utf8' }));
            // Assert
            expect(prepared.status, prepared.stderr).toBe(0);
            expect(result.runCi, `${file}/${job}/${comparison}`).toBe(runCi);
            expect(git(consumer, 'rev-parse', 'HEAD')).toBe(head);
            expect(git(consumer, 'rev-parse', '--is-shallow-repository')).toBe('true');
            const commits = git(consumer, 'cat-file', '--batch-all-objects', '--batch-check=%(objecttype)').split('\n').filter((type) => type === 'commit');
            expect(commits.length).toBe(comparison === base ? 2 : 1);
            expect((existsSync(trace) ? readFileSync(trace, 'utf8') : '').split('built-in: git fetch ').length - 1).toBe(comparison === base || comparison === '1'.repeat(40) ? 1 : 0);
            if (comparison === base) {
              // Act
              const cached = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', preparation.run], { cwd: consumer, encoding: 'utf8', env: { ...process.env, CI_DIFF_BASE_SHA: comparison, GIT_TRACE: trace } });
              // Assert
              expect(cached.status, cached.stderr).toBe(0);
              expect(readFileSync(trace, 'utf8').split('built-in: git fetch ').length - 1).toBe(1);
            }
          }
        }
      } finally { rmSync(directory, { recursive: true, force: true }); }
    });

    // integration_id: quality-workflow-contract
    test('quality caller passes explicit inputs and preserves the summary check without copying quality jobs', () => {
      const caller = yaml.parse(read('workflows/quality/quality-gate.yml'));
      const callee = yaml.parse(read('.github/workflows/ci-quality.yml'));
      expect(Object.keys(caller.jobs)).toStrictEqual(['quality', 'summary']);
      expect(caller.env).toBe(undefined);
      expect(caller.jobs.quality.steps).toBe(undefined);
      expect(caller.jobs.quality.secrets).toBe(undefined);
      expect(caller.jobs.quality.permissions.contents).toBe('read');
      expect(caller.jobs.quality.uses).toBe('a3-suite/a3-ci-github/.github/workflows/ci-quality.yml@<quality-workflow-sha>');
      expect(Object.keys(caller.jobs.quality.with).sort()).toStrictEqual(Object.keys(callee.on.workflow_call.inputs).sort());
      expect(Object.keys(callee.on)).toStrictEqual(['workflow_call']);
      expect(callee.on.workflow_call.secrets).toBe(undefined);
      expect(callee.concurrency).toBe(undefined);
      expect(caller.jobs.summary.needs).toBe('quality');
      expect(caller.jobs.summary.if).toBe('always()');
      expect(caller.jobs.summary.name).toBe(undefined);
      expect(Object.keys(callee.jobs)).toStrictEqual(['trusted', 'untrusted-pr', 'summary']);
      expect(callee.on.workflow_call.inputs['jq-version'].required).toBe(false);
      expect(callee.on.workflow_call.inputs['jq-version'].default).toBe('');
      for (const id of ['trusted', 'untrusted-pr']) {
        const steps = callee.jobs[id].steps;
        const jqSteps = steps.filter((step) => /actions\/ci-(?:jq-provisioner|github-toolchain-verifier)@/.test(step.uses ?? ''));
        expect(jqSteps.length).toBe(2);
        for (const step of jqSteps) {
          expect(step.if).toBe("steps.change-scope.outputs['run-ci'] != 'false' && env.CI_JQ_VERSION != ''");
          expect(step.with['jq-version']).toBe('${{ env.CI_JQ_VERSION }}');
        }
        for (const step of steps.filter((step) => /actions\/ci-quality-(?:toolchain|adapter)@/.test(step.uses ?? ''))) {
          expect(step.if).toBe("steps.change-scope.outputs['run-ci'] != 'false'");
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
          expect(run.status === 0, `${result}: ${run.stderr}`).toBe(result === 'success');
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
            expect(result.status, `${file}: ${JSON.stringify(scenario)}: ${result.stderr}`).toBe(scenario.status);
            if (scenario.status === 0) expect(readFileSync(output, 'utf8').split('\n').includes(`root=${scenario.root}`)).toBeTruthy();
          } finally { rmSync(directory, { recursive: true, force: true }); }
        }
      }
    });
  });
});
const includesAll = (text, values) => values.forEach((value) => expect(text).toMatch(value));
const jobBlock = (workflow, id) => {
  const marker = `\n  ${id}:\n`;
  const start = workflow.indexOf(marker);
  expect(start, `missing job: ${id}`).not.toBe(-1);
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
  expect(found, `missing step containing: ${marker}`).toBeTruthy();
  return found;
};
const stepIndexContaining = (job, marker) => {
  const steps = stepsOf(job);
  const index = steps.indexOf(stepContaining(job, marker));
  expect(index, `missing ordered step: ${marker}`).not.toBe(-1);
  return index;
};
const stepBlock = (job, marker) => {
  const start = job.indexOf(`      ${marker}\n`);
  expect(start, `missing step: ${marker}`).not.toBe(-1);
  const remainder = job.slice(start);
  const next = remainder.slice(1).search(/\n      - (?:name:|uses:)/);
  return next === -1 ? remainder : remainder.slice(0, next + 1);
};
const summaryNeeds = (summary) => {
  const inline = summary.match(/^    needs: \[([^\]]+)\]$/m);
  if (inline) return inline[1].split(',').map((value) => value.trim());
  const scalar = summary.match(/^    needs: ([a-zA-Z0-9_-]+)$/m);
  expect(scalar, 'summary needs must use a scalar or inline list').toBeTruthy();
  return [scalar[1]];
};
const assertNeeds = (job, expected) => {
  expect([...summaryNeeds(job)].sort()).toStrictEqual([...expected].sort());
};
const unitRecord = (summary, unit) => {
  const marker = `\"unit\":\"${unit}\"`;
  const start = summary.indexOf(marker);
  expect(start, `missing summary unit: ${unit}`).not.toBe(-1);
  const remainder = summary.slice(start);
  const end = remainder.search(/\},\{\"unit\"|\}\]\}/);
  expect(end, `unterminated summary unit: ${unit}`).not.toBe(-1);
  return remainder.slice(0, end + 1);
};

describe("workflow-contracts", () => {
  describe("quality-workflow-contract", () => {
    // integration_id: quality-workflow-contract
    test('quality workflow declares trusted execution and aggregate summary', () => {
      const workflow = read('.github/workflows/ci-quality.yml').replaceAll('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', 'actions/checkout@<commit-sha>');
      includesAll(workflow, [/workflow_call:/, /permissions:\n  contents: read/]);
      const trusted = jobBlock(workflow, 'trusted');
      expect(trusted).toMatch(/^    if: \$\{\{ github\.event_name != 'pull_request' \|\| github\.event\.pull_request\.head\.repo\.full_name == github\.repository \}\}$/m);
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
      expect(untrusted).toMatch(/^    if: \$\{\{ github\.event_name == 'pull_request' && github\.event\.pull_request\.head\.repo\.full_name != github\.repository \}\}$/m);
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
        expect(selected(baseCheckout(main.trusted), id, descriptor), `${id}: trusted checkout`).toBe(required);
        expect(selected(resolver, id, descriptor), `${id}: trusted resolver`).toBe(required);
        expect(selected(baseCheckout(main['untrusted-pr']), id, descriptor), `${id}: fork checkout`).toBe(descriptor !== '');
        expect(selected(baseCheckout(platforms.platform), id, descriptor), `${id}: platform checkout`).toBe(required);
        expect(selected(baseCheckout(platforms.platform), id, descriptor, 'true', '.'), `${id}: platform bootstrap`).toBe(false);
        expect(selected(baseCheckout(main.trusted), id, descriptor, 'false'), `${id}: docs-only checkout`).toBe(false);
        expect(selected(resolver, id, descriptor, 'false'), `${id}: docs-only resolver`).toBe(false);
        expect(selected(baseCheckout(main['untrusted-pr']), id, descriptor, 'false'), `${id}: docs-only fork`).toBe(false);
        if (!required) {
          const bundle = standardBundles.find((entry) => entry.id === id);
          expect(yaml.parse(bundle.descriptor).projectSettings.requiredScripts, `${id}: skipped trusted root must remain unused`).toStrictEqual([]);
        }
      }
      expect(baseCheckout(platforms['resolve-platforms']).if, 'manifest and selection resolution still require base assets').toBe(undefined);
    });

    // integration_id: quality-workflow-contract
    test('platform caller passes explicit inputs and retains the summary identity', () => {
      const caller = yaml.parse(read('workflows/quality/quality-gate-platforms.yml'));
      const callee = yaml.parse(read('.github/workflows/ci-quality-platforms.yml'));
      expect(Object.keys(caller.jobs)).toStrictEqual(['platforms', 'platform-summary']);
      expect(caller.env).toBe(undefined);
      expect(caller.jobs.platforms.steps).toBe(undefined);
      expect(caller.jobs.platforms.secrets).toBe(undefined);
      expect(caller.jobs.platforms.permissions).toStrictEqual({ contents: 'read' });
      expect(caller.jobs.platforms.uses).toBe('a3-suite/a3-ci-github/.github/workflows/ci-quality-platforms.yml@<quality-platforms-workflow-sha>');
      expect(Object.keys(caller.jobs.platforms.with).sort()).toStrictEqual(Object.keys(callee.on.workflow_call.inputs).sort());
      expect(Object.keys(callee.on)).toStrictEqual(['workflow_call']);
      expect(callee.on.workflow_call.secrets).toBe(undefined);
      expect(callee.concurrency).toBe(undefined);
      expect(caller.jobs['platform-summary'].name).toBe('quality-gate-platforms / summary');
      expect(callee.jobs['platform-summary'].name).not.toBe(caller.jobs['platform-summary'].name);
      expect(caller.jobs['platform-summary'].needs).toBe('platforms');
      expect(caller.jobs['platform-summary'].if).toBe('always()');
      expect(Object.keys(callee.jobs)).toStrictEqual(['resolve-platforms', 'platform', 'platform-summary']);
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
          expect(result.status, result.stderr).toBe(0);
          const payload = readFileSync(output, 'utf8').trim().slice('summary='.length);
          const records = JSON.parse(payload).jobs;
          expect(records[0].result).toBe(status);
          expect(records[0].evidence).toBe(env.WORKFLOW_RUN_URL);
          if (accepted && runCi === 'true') expect(records[0].reason).toBe(`all selected platforms succeeded: ${expected}`);
          if (accepted && runCi === 'false') expect(records.slice(1).map((entry) => [entry.unit, entry.result])).toStrictEqual([['platform:linux-x64', '対象外'], ['platform:macos-arm64', '対象外']]);
          const action = spawnSync(process.execPath, [path.join(root, 'actions/ci-quality-summary/dist/index.js')], {
            cwd: directory, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true', 'INPUT_SUMMARY-JSON': payload,
              'INPUT_SUMMARY-PATH': path.join(directory, 'summary.md'), 'INPUT_EVIDENCE-PATH': path.join(directory, 'evidence.md') },
          });
          expect(enforcement.status === 0 && action.status === 0, JSON.stringify({ resolve, platform, runCi, expected })).toBe(accepted);
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
      expect(resolve).not.toMatch(/CoreLoader|PyYAML|pyyaml|Set up uv|uv run/);
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
      for (const pattern of [
        /if: always\(\)/,
        /"rawResult":"\$\{\{ needs\.trusted\.result \}\}"/,
        /"applicable":\$\{\{ needs\.trusted\.result != 'skipped' \}\}/,
        /"rawResult":"\$\{\{ needs\.untrusted-pr\.result \}\}"/,
        /"applicable":\$\{\{ needs\.trusted\.result == 'skipped' \}\}/,
      ]) expect(summary).toMatch(pattern);
    });
  });
});

describe("contract.ci-selective-distribution.publication", () => {
  describe("repository-selective-distribution-release", () => {
    // contract_id: contract.ci-selective-distribution.publication
    // integration_id: repository-selective-distribution-release
    test('repository release publishes and reads back the exact selective distribution asset set before aliases', () => {
      const workflow = read('.github/workflows/release.yml');
      expect(workflow).toMatch(/^permissions: \{\}$/m);
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
      expect(prepare).not.toMatch(/GH_TOKEN|contents: write/);
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
      expect(publish).not.toMatch(/--clobber|--force/);
      const readback = jobBlock(workflow, 'readback-distribution');
      assertNeeds(readback, ['prepare-distribution', 'publish-distribution']);
      includesAll(readback, [
        /contents: read/,
        /manage-distribution-release\.sh readback release-distribution/,
        /GH_TOKEN: \$\{\{ github\.token \}\}/,
      ]);
      const aliases = jobBlock(workflow, 'update-aliases');
      assertNeeds(aliases, ['readback-distribution']);
      expect(aliases).toMatch(/runtime\/repository\/update-release-aliases\.sh/);
      const summary = jobBlock(workflow, 'summary');
      assertNeeds(summary, [
        'prepare-distribution',
        'publish-distribution',
        'readback-distribution',
        'update-aliases',
      ]);
      includesAll(summary, [/if: always\(\)/, /test "\$READBACK_RESULT" = success/]);
    });
  });
});

describe("workflow-contracts", () => {
  describe("release-request-workflow-contract", () => {
    // integration_id: release-request-workflow-contract
    test('release request workflow binds annotated tags without release publication permission', () => {
      const workflow = read('workflows/release/release-request-tag.yml');
      expect(workflow).toMatch(/push:\n    tags:/);
      includesAll(jobBlock(workflow, 'request'), [/permissions:\n      actions: write\n      contents: read/, /ci-annotated-tag-resolver@/, /ci-release-request-handoff@/]);
      expect(workflow).not.toMatch(/contents: write/);
      expect(workflow).not.toMatch(/CI_(?:GH|JQ|SHA256SUM)_VERSION|ci-(?:gh-provisioner|jq-provisioner|github-toolchain-verifier)@/);
      includesAll(jobBlock(workflow, 'summary'), [/needs: request/, /if: always\(\)/, /ci-quality-summary@/]);
    });

    // integration_id: release-request-workflow-contract
    test('release request workflow reports handoff failure in its summary', () => {
      const summary = jobBlock(read('workflows/release/release-request-tag.yml'), 'summary');
      for (const pattern of [/if: always\(\)/, /ci-quality-summary@/, /request job result:/, /"rawResult":"\$\{\{ needs\.request\.result \}\}"/]) expect(summary).toMatch(pattern);
    });
  });
});

const assertPublicationControl = (text, kind) => {
  const workflow = yaml.parse(text);
  const entryJob = kind === 'release' ? 'authority' : 'publish';
  const entry = workflow.jobs[entryJob].steps[0];
  expect(entry.id).toBe('publication-entry');
  expect(entry.env).toStrictEqual({
    REPOSITORY: '${{ github.repository }}',
    DEFAULT_BRANCH: '${{ github.event.repository.default_branch }}',
    CALLER_EVENT: '${{ github.event_name }}',
    CALLER_WORKFLOW_REF: '${{ github.workflow_ref }}',
    CONTROL_SHA: '${{ github.workflow_sha }}',
  });
  expect(text).not.toMatch(/ci-workflow-identity@|job\.workflow_|steps\.workflow-identity|control_sha:/);
  const valid = {
    REPOSITORY: 'example/consumer', DEFAULT_BRANCH: 'main', CALLER_EVENT: 'workflow_run',
    CALLER_WORKFLOW_REF: `example/consumer/.github/workflows/${kind}-publication-caller.yml@refs/heads/main`,
    CONTROL_SHA: 'a'.repeat(40),
  };
  const run = (env) => spawnSync('bash', ['-c', entry.run], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  expect(run(valid).status).toBe(0);
  for (const [field, values] of Object.entries({
    REPOSITORY: ['', 'other/consumer'], DEFAULT_BRANCH: ['', 'feature'],
    CALLER_EVENT: ['workflow_dispatch', 'push', 'pull_request'],
    CALLER_WORKFLOW_REF: ['', `other/consumer/.github/workflows/${kind}-publication-caller.yml@refs/heads/main`, `example/consumer/.github/workflows/other.yml@refs/heads/main`, `example/consumer/.github/workflows/${kind}-publication-caller.yml@refs/tags/v1`, '$(exit 0)'],
    CONTROL_SHA: ['', 'main', 'a'.repeat(39), 'A'.repeat(40), '$(exit 0)'],
  })) for (const value of values) expect(run({ ...valid, [field]: value }).status, `${kind}: ${field}=${value}`).not.toBe(0);
  const controlJobs = kind === 'release' ? ['authority', 'quality', 'assemble', 'publish'] : ['publish'];
  for (const jobName of controlJobs) {
    const job = workflow.jobs[jobName];
    if (jobName !== entryJob) {
      expect([job.needs].flat().includes('authority')).toBeTruthy();
      if (job.if !== undefined) expect(job.if).toMatch(/needs\.authority\.result == 'success'/);
      expect(job.steps.some(step => step.id === 'publication-entry')).toBe(false);
    }
    const index = job.steps.findIndex(step => step.uses?.startsWith('actions/checkout@') && step.with?.ref === '${{ github.workflow_sha }}');
    expect(index >= 0).toBeTruthy();
    expect(job.steps[index].with.repository).toBe('${{ github.repository }}');
    const verification = job.steps[index + 1];
    expect(verification.name).toBe('Verify trusted control checkout');
    expect(verification.env.CONTROL_SHA).toBe('${{ github.workflow_sha }}');
    const git = jobName === 'quality' ? 'git -C .ci-base' : 'git';
    expect(verification.run).toBe(`test "$(${git} rev-parse HEAD)" = "$CONTROL_SHA"`);
  }
};

describe("workflow-contracts", () => {
  describe("release-publication-workflow-contract", () => {
    // integration_id: release-publication-workflow-contract
    test('release publication workflows separate request validation from privileged publication', () => {
      const request = read('workflows/release/release-publication-request.yml');
      const caller = read('workflows/release/release-publication-caller.yml');
      const publication = read('.github/workflows/ci-release-publication.yml');
      expect(request).toMatch(/workflow_dispatch:/);
      includesAll(jobBlock(request, 'request'), [/contents: read/, /operation: create-request/]);
      includesAll(jobBlock(request, 'summary'), [/needs: request/, /if: always\(\)/, /ci-quality-summary@/]);
      expect(caller).toMatch(/workflow_run:/);
      includesAll(jobBlock(caller, 'validate-request'), [/actions: read/, /contents: read/, /operation: verify-publication-request/]);
      const callerPublish = jobBlock(caller, 'publish');
      assertNeeds(callerPublish, ['validate-request']);
      includesAll(callerPublish, [/contents: write/, /uses: a3-suite\/a3-ci-github\/\.github\/workflows\/ci-release-publication\.yml@<release-publication-workflow-sha>/]);
      const callerSummary = jobBlock(caller, 'summary');
      assertNeeds(callerSummary, ['validate-request', 'publish']);
      includesAll(callerSummary, [/if: always\(\)/, /ci-quality-summary@/]);
      expect(publication).toMatch(/workflow_call:/);
      assertPublicationControl(publication, 'release');
      const qualitySteps = yaml.parse(publication).jobs.quality.steps;
      const qualityAdapter = qualitySteps.find(step => step.id === 'quality-adapter');
      expect(qualityAdapter.with['bundle-path']).toBe("${{ env.CI_ADAPTER_DESCRIPTOR && format('.ci-base/{0}', env.CI_ADAPTER_DESCRIPTOR) || '' }}");
      expect(qualityAdapter.with['require-trusted-project-scripts']).toBe('true');
      expect(qualityAdapter.with['trusted-project-root']).toBe('.ci-base');
      const qualityCheckout = qualitySteps.find(step => step.with?.path === '.ci-base');
      const qualityVerification = qualitySteps.find(step => step.name === 'Verify trusted control checkout');
      expect(qualityCheckout.if).toBe("env.CI_STANDARD_BUNDLE_ID != 'rust-cargo-quality' || env.CI_ADAPTER_DESCRIPTOR != ''");
      expect(qualityVerification.if).toBe(qualityCheckout.if);
      includesAll(jobBlock(publication, 'authority'), [/Verify publication entry/, /Verify publication request workflow run/]);
      const configuration = yaml.parse(publication).jobs.authority.steps.find(step => step.id === 'config');
      const sourcesTemplate = configuration.with['sources-json'];
      const runtimeKeys = [
        'CI_LANGUAGE_PROFILE', 'CI_TOOLCHAIN_VERSION', 'CI_PLATFORM_MANIFEST',
        'CI_RELEASE_IMPLEMENTATION', 'CI_RELEASE_OWNER_CONTRACT', 'CI_CARGO_MANIFEST_PATH',
        'CI_CARGO_LOCK_PATH', 'CI_RELEASE_BINARY_NAME', 'CI_RELEASE_ASSET_PREFIX',
      ];
      const stringExpressions = [...runtimeKeys.map(key => `env.${key}`), 'inputs.supplemental_release_asset_owner_contract'];
      for (const expression of stringExpressions) {
        expect(sourcesTemplate.includes('${{ toJSON(' + expression + ') }}'), expression).toBeTruthy();
        for (const value of [String.raw`tool\u002fstable`, 'tool","CI_LANGUAGE_PROFILE":"other', 'a\t"\\b']) {
          for (const enabled of [false, true]) {
            const values = Object.fromEntries(runtimeKeys.map(key => [`env.${key}`, 'sample']));
            values['inputs.supplemental_release_asset_owner_contract'] = 'owner';
            values['inputs.supplemental_release_asset_enabled'] = enabled;
            values[expression] = value;
            const rendered = sourcesTemplate.replace(/\$\{\{\s*(toJSON\((?:env|inputs)\.[A-Za-z_]+\)|(?:env|inputs)\.[A-Za-z_]+)\s*\}\}/g, (_, entry) =>
              entry.startsWith('toJSON(') ? JSON.stringify(values[entry.slice(7, -1)]) : String(values[entry]));
            const snapshot = resolveConfigSnapshot(JSON.parse(rendered));
            const key = expression.startsWith('env.') ? expression.slice(4) : 'CI_SUPPLEMENTAL_RELEASE_ASSET_OWNER_CONTRACT';
            expect(snapshot.values[key], expression).toBe(value);
            expect(snapshot.values.CI_SUPPLEMENTAL_RELEASE_ASSET_ENABLED).toBe(String(enabled));
            for (const other of runtimeKeys.filter(other => other !== key)) expect(snapshot.values[other], other).toBe('sample');
          }
        }
      }
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
      expect(publication).not.toMatch(/run: \.ci\/scripts\/ci-release-supplemental-asset\.sh/);
      const publicationJob = jobBlock(publication, 'publish');
      assertNeeds(publicationJob, ['authority', 'assemble']);
      expect(publicationJob).toMatch(/contents: write/);
      expect(stepIndexContaining(publicationJob, '- name: Verify trusted control checkout') < stepIndexContaining(publicationJob, '- name: Validate release handoff integrity')).toBeTruthy();
      expect(stepIndexContaining(publicationJob, '- name: Validate release handoff integrity') < stepIndexContaining(publicationJob, '- name: Verify approval is still valid')).toBeTruthy();
      expect(stepIndexContaining(publicationJob, '- name: Verify approval is still valid') < stepIndexContaining(publicationJob, '- id: publish')).toBeTruthy();
      expect(stepIndexContaining(publicationJob, '- id: publish') < stepIndexContaining(publicationJob, '- name: Verify publication readback evidence')).toBeTruthy();
      expect(publicationJob.split(/^    steps:$/m)[0]).not.toMatch(/GH_TOKEN|CI_GITHUB_TOKEN/);
      includesAll(stepContaining(publicationJob, '- id: publish'), [/GH_TOKEN: \$\{\{ github\.token \}\}/, /ci-release-publisher@<release-publication-action-sha>/, /if: env.CI_RELEASE_IMPLEMENTATION == 'rust-cli-release'/]);
      expect(stepContaining(publicationJob, '- id: publish')).not.toMatch(/ci-release-publish\.sh|CI_GITHUB_TOKEN/);
      includesAll(stepContaining(publicationJob, '- id: publish_owner'), [/if: env.CI_RELEASE_IMPLEMENTATION != 'rust-cli-release'/, /ci-release-publish\.sh/]);
      const publicationSummary = jobBlock(publication, 'summary');
      assertNeeds(publicationSummary, ['authority', 'source-gate', 'quality', 'build', 'supplemental-asset', 'assemble', 'publish']);
      includesAll(publicationSummary, [/if: always\(\)/, /ci-quality-summary@/]);
    });

    // integration_id: release-publication-workflow-contract
    test('release publication workflows preserve failed and unknown outcomes', () => {
      const request = jobBlock(read('workflows/release/release-publication-request.yml'), 'summary');
      const publication = jobBlock(read('workflows/release/release-publication-caller.yml'), 'summary');
      for (const pattern of [/if: always\(\)/, /"rawResult":"\$\{\{ needs\.request\.result \}\}"/]) expect(request).toMatch(pattern);
      for (const pattern of [/if: always\(\)/, /"rawResult":"\$\{\{ needs\.publish\.result \}\}"/]) expect(publication).toMatch(pattern);
    });
  });
});

describe("workflow-contracts", () => {
  describe("package-publication-workflow-contract", () => {
    // integration_id: package-publication-workflow-contract
    test('package workflows separate preparation request validation and publication', () => {
      const request = read('workflows/package/package-publication-request.yml');
      const caller = read('workflows/package/package-publication-caller.yml');
      const preparation = read('.github/workflows/ci-package-preparation.yml');
      const publication = read('.github/workflows/ci-package-publication.yml');
      expect(request).toMatch(/workflow_dispatch:/);
      includesAll(jobBlock(request, 'request'), [/permissions: \{\}/, /operation: create/]);
      includesAll(jobBlock(request, 'summary'), [/needs: request/, /if: always\(\)/, /ci-quality-summary@/]);
      expect(caller).toMatch(/workflow_run:/);
      includesAll(jobBlock(caller, 'validate-request'), [/actions: read/, /operation: verify/]);
      const prepareJob = jobBlock(caller, 'prepare');
      assertNeeds(prepareJob, ['validate-request']);
      expect(prepareJob).toMatch(/uses: a3-suite\/a3-ci-github\/\.github\/workflows\/ci-package-preparation\.yml@<package-preparation-workflow-sha>/);
      const publishJob = jobBlock(caller, 'publish');
      assertNeeds(publishJob, ['validate-request', 'prepare']);
      includesAll(publishJob, [/packages: write/, /uses: a3-suite\/a3-ci-github\/\.github\/workflows\/ci-package-publication\.yml@<package-publication-workflow-sha>/]);
      const callerSummary = jobBlock(caller, 'summary');
      assertNeeds(callerSummary, ['validate-request', 'prepare', 'publish']);
      includesAll(callerSummary, [/if: always\(\)/, /ci-quality-summary@/]);
      expect(preparation).toMatch(/workflow_call:/);
      const preparationContract = yaml.parse(preparation);
      expect(Object.keys(preparationContract.on.workflow_call.inputs).sort()).toStrictEqual(['language_profile', 'source_sha', 'target_identity', 'toolchain', 'version']);
      expect(Object.values(preparationContract.on.workflow_call.inputs).every((input) => input.required === true && input.type === 'string')).toBeTruthy();
      expect(Object.keys(preparationContract.on.workflow_call.outputs).sort()).toStrictEqual(['artifact_id', 'handoff_run_id', 'publish_version']);
      expect(preparationContract.permissions).toStrictEqual({});
      expect(preparationContract.on.workflow_call.secrets).toBe(undefined);
      expect(preparationContract.concurrency).toBe(undefined);
      expect(preparationContract.jobs.build.permissions).toStrictEqual({ contents: 'read' });

      const versionPlanStep = preparationContract.jobs['version-plan'].steps
        .find((step) => step.name === 'Write owner-approved version plan');
      expect(versionPlanStep.env.PUBLISH_VERSION).toBe('${{ inputs.version }}');
      expect(versionPlanStep.env.PUBLISH_VERSION_JSON).toBe('${{ toJSON(inputs.version) }}');
      expect(!preparationContract.jobs['version-plan'].steps.some((step) => step.uses?.startsWith('actions/setup-node@'))).toBeTruthy();
      mkdirSync(path.join(root, 'tmp'), { recursive: true });
      const directory = mkdtempSync(path.join(root, 'tmp/package-version-plan-'));
      try {
        for (const version of ['1.2.3', String.raw`1\u002e2\u002e3`, '1","publishVersion":"2', 'a\t"\\b']) {
          // Act
          const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', versionPlanStep.run], {
            cwd: directory, encoding: 'utf8',
            env: { ...process.env, PUBLISH_VERSION: version, PUBLISH_VERSION_JSON: JSON.stringify(version) },
          });
          // Assert
          expect(result.status, result.stderr).toBe(0);
          const plan = JSON.parse(readFileSync(path.join(directory, 'version-plan.json'), 'utf8'));
          expect(plan).toStrictEqual({ strategy: 'exact', publishVersion: version });
          expect(materializePublishVersion(plan)).toBe(version);
        }
      } finally { rmSync(directory, { recursive: true, force: true }); }

      expect(jobBlock(preparation, 'build')).toMatch(/needs: version-plan/);
      expect(publication).toMatch(/workflow_call:/);
      assertPublicationControl(publication, 'package');
      const publicationJob = jobBlock(publication, 'publish');
      includesAll(publicationJob, [
        /packages: write/,
        /^      - name: Verify publication entry$/m,
        /CALLER_WORKFLOW_REF: \$\{\{ github\.workflow_ref \}\}/,
      ]);
      expect(stepIndexContaining(publicationJob, '- name: Verify publication entry') < stepIndexContaining(publicationJob, '- name: Validate package handoff integrity')).toBeTruthy();
      expect(stepIndexContaining(publicationJob, '- name: Validate package handoff integrity') < stepIndexContaining(publicationJob, '- name: Publish verified package handoff')).toBeTruthy();
      expect(publicationJob.split(/^    steps:$/m)[0]).not.toMatch(/PACKAGE_REGISTRY_TOKEN|CI_GITHUB_TOKEN/);
      includesAll(stepContaining(publicationJob, '- name: Publish verified package handoff'), [
        /PACKAGE_REGISTRY_TOKEN: \$\{\{ secrets\.PACKAGE_REGISTRY_TOKEN \}\}/,
        /CI_GITHUB_TOKEN: \$\{\{ github\.token \}\}/,
      ]);
      expect(publication).not.toMatch(/expected_caller=/);
      includesAll(jobBlock(publication, 'summary'), [/needs: publish/, /if: always\(\)/, /ci-quality-summary@/]);
    });

    // integration_id: package-publication-workflow-contract
    test('package workflows preserve failed and unknown outcomes', () => {
      const request = jobBlock(read('workflows/package/package-publication-request.yml'), 'summary');
      const publication = jobBlock(read('workflows/package/package-publication-caller.yml'), 'summary');
      for (const pattern of [/if: always\(\)/, /"rawResult":"\$\{\{ needs\.request\.result \}\}"/]) expect(request).toMatch(pattern);
      for (const pattern of [/if: always\(\)/, /"rawResult":"\$\{\{ needs\.publish\.result \}\}"/]) expect(publication).toMatch(pattern);
    });
  });
});

describe("workflow-contracts", () => {
  describe("repository-quality-delivery-regression", () => {
    // integration_id: repository-quality-delivery-regression
    test('repository quality workflow scopes branch events and cancels only stale PR runs', () => {
      const workflow = read('.github/workflows/quality-gate.yml');
      expect(workflow).toMatch(/^  push:\n    branches: \[main, develop, 'release\/\*\*', 'hotfix\/\*\*'\]$/m);
      expect(workflow).toMatch(/^  pull_request:\n    branches: \[main, develop, 'release\/\*\*', 'hotfix\/\*\*'\]$/m);
      expect(workflow).toMatch(/^  group: quality-gate-\$\{\{ github\.workflow \}\}-\$\{\{ github\.event_name == 'pull_request' && format\('pr-\{0\}', github\.event\.pull_request\.number\) \|\| format\('run-\{0\}', github\.run_id\) \}\}$/m);
      expect(workflow).toMatch(/^  cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}$/m);
    });

    // integration_id: repository-quality-delivery-regression
    test('repository quality workflow keeps the required hosted check behind Linux and Windows evidence', () => {
      const workflow = read('.github/workflows/quality-gate.yml');
      const linux = jobBlock(workflow, 'contract-linux');
      const windows = jobBlock(workflow, 'rust-windows');
      const aggregate = jobBlock(workflow, 'contract');
      expect(linux).toMatch(/^    name: CI Action contract \/ Linux$/m);
      includesAll(windows, [
        /^    name: Rust release contract \/ Windows$/m,
        /^    runs-on: windows-2025$/m,
        /--testNamePattern="PowerShell\|Windows"/,
      ]);
      expect(new Set(summaryNeeds(aggregate))).toStrictEqual(new Set(['contract-linux', 'rust-windows']));
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
        expect(external.length > 0, `${relative} must pin external provider actions`).toBeTruthy();
        for (const { action, sha } of external) {
          const escaped = action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          expect(registry, `${relative} uses ${action}@${sha} without a matching registry approval`).toMatch(new RegExp(`\\baction: ${escaped}\\b[^\\n]*\\bcommitSha: ${sha}\\b`));
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
          expect(declaredNames.includes(input), `${stepName} passes undeclared input ${input} to ${action}`).toBeTruthy();
        }
        for (const input of declared) {
          if (input.required) {
            expect(provided.includes(input.name), `${stepName} omits required input ${input.name} of ${action}`).toBeTruthy();
          }
        }
        if (runMatch) direct += 1;
        checked += 1;
      }
      expect(checked > 0, 'expected the repository gate to use local Action steps').toBeTruthy();
      expect(direct > 0, 'expected the repository gate to validate direct Action invocations').toBeTruthy();
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
        expect([...rows].sort(), `${relative} summary rows must match needs`).toStrictEqual([...needs].sort());
        expect(new Set(rows).size, `${relative} summary rows must be unique`).toBe(rows.length);
      }
    });
  });
});

describe("workflow-contracts", () => {
  describe("failure-diagnostics-contract", () => {
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
        expect(summary).not.toMatch(/secrets(?:\.|\s*\[)/);

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
          expect(record).toMatch(new RegExp(`"rawResult":"\\$\\{\\{ needs\\.${escapedJob}\\.result \\}\\}"`));
          expect(record).toMatch(/"applicable":/);
          expect(record).toMatch(/"evidence":"\$\{\{ env\.WORKFLOW_RUN_URL \}\}"/);
          expect(record).toMatch(new RegExp(`"reason":"[^"]*needs\\.${escapedJob}\\.result`));
        }
      }
    });
  });
});

describe("workflow-contracts", () => {
  describe("quality-workflow-contract", () => {
    // integration_id: quality-workflow-contract
    test('quality toolchain callers bind four inputs and preserve execution gates', () => {
      const pairs = [['.github/workflows/ci-quality.yml', 'trusted'], ['.github/workflows/ci-quality.yml', 'untrusted-pr'], ['.github/workflows/ci-quality-platforms.yml', 'platform'], ['.github/workflows/ci-release-publication.yml', 'quality']];
      const contract = yaml.parse(read('actions/ci-quality-toolchain/action.yml'));
      for (const [file, jobId] of pairs) {
        const workflow = yaml.parse(read(file));
        const job = workflow.jobs[jobId];
        const call = job.steps.filter((step) => step.uses?.includes('/actions/ci-quality-toolchain@'));
        expect(call.length, file).toBe(1);
        expect(call[0].uses).toBe('a3-suite/a3-ci-github/actions/ci-quality-toolchain@<release-publication-action-sha>');
        expect(Object.keys(call[0].with).sort()).toStrictEqual(Object.keys(contract.inputs).sort());
        expect(call[0].with).toStrictEqual({ 'language-profile': '${{ env.CI_LANGUAGE_PROFILE }}', 'toolchain-version': '${{ env.CI_TOOLCHAIN_VERSION }}', 'uv-version': '${{ env.CI_UV_VERSION }}', 'cargo-audit-version': '${{ env.CI_CARGO_AUDIT_VERSION }}' });
        expect(call[0].if).toBe(file.includes('ci-quality.yml') ? "steps.change-scope.outputs['run-ci'] != 'false'" : undefined);
        expect(call[0]['continue-on-error']).toBe(undefined);
        expect(job.steps.some((step) => step.uses?.includes('/actions/ci-quality-adapter@'))).toBeTruthy();
        expect(job.steps.every((step) => step.name !== 'Report project quality adapter result' && !step.env?.CI_QUALITY_RESULT_PATH)).toBeTruthy();
        expect(!job.steps.some((step) => step.run?.includes('rustup toolchain install') || step.uses?.startsWith('actions/setup-node@') || step.uses?.startsWith('actions/setup-python@') || step.uses?.startsWith('astral-sh/setup-uv@'))).toBeTruthy();
      }
    });
  });
});
