import { existsSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import yaml from 'yaml';
import { checkActionReferences, checkProviderReferences, checkRepository, registryPath, repositorySnapshot } from '../runtime/repository/check-provider-references.mjs';
import { verifyActionReferenceContracts } from '../runtime/repository/verify-action-reference-contracts.mjs';
import path from 'node:path';
import { test, describe, expect, onTestFinished } from 'vitest';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createDocsOnlyMatcher, detectChangeScope } from '../actions/ci-change-scope/src/scope.ts';
import { materializePublishVersion } from '../actions/ci-publish-version/src/materialize.ts';
import { resolveConfigSnapshot } from '../actions/ci-config-snapshot/src/snapshot.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');
const actionRef = yaml.parse(read('skills/ci-github/references/ci-github-preset-assets.reference.yml')).actionization.implementationSource.exactRef;

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
        new RegExp(`^        uses: a3-suite/a3-ci-github/actions/ci-quality-adapter@${actionRef}$`, 'm'),
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
        new RegExp(`^        uses: a3-suite/a3-ci-github/actions/ci-quality-adapter@${actionRef}$`, 'm'),
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
        new RegExp(`uses: a3-suite/a3-ci-github/actions/ci-platform-matrix@${actionRef}`),
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
      expect(workflow).toMatch(/workflow_dispatch:/);
      expect(workflow).not.toMatch(/^  push:/m);
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
        /check-provider-references\.mjs --contracts --release-tag/,
        /implementation_binding_status: \$\{\{ steps\.provider-binding\.outputs\.implementation_binding_status \}\}/,
        /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/,
      ]);
      expect(prepare).not.toMatch(/contents: write/);
      expect(prepare).not.toContain('actions: read');
      expect(workflow).not.toContain('acceptance-run-urls');
      expect(prepare).not.toContain('verify-hosted-workflow-acceptance.mjs');
      expect(prepare).not.toContain('--acceptance-file');
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
      expect(publish).toContain('APPROVED_RELEASE_NOTES: ${{ inputs.release-notes }}');
      const readback = jobBlock(workflow, 'readback-distribution');
      assertNeeds(readback, ['prepare-distribution', 'publish-distribution']);
      includesAll(readback, [
        /contents: read/,
        /manage-distribution-release\.sh readback release-distribution/,
        /GH_TOKEN: \$\{\{ github\.token \}\}/,
      ]);
      const aliases = jobBlock(workflow, 'update-aliases');
      assertNeeds(aliases, ['prepare-distribution', 'readback-distribution']);
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
      expect(yaml.parse(caller).jobs.publish.with).toMatchObject({
        supplemental_release_asset_enabled: '<supplemental-release-asset-enabled>',
        supplemental_release_asset_owner_contract: '<supplemental-release-asset-owner-contract>',
        supplemental_release_asset_implementation: '<supplemental-release-asset-implementation>',
        supplemental_release_asset_config_path: '<supplemental-release-asset-config-path>',
      });
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
      includesAll(jobBlock(publication, 'authority'), [/Verify publication entry/, /Verify standard Release authority/]);
      const provider = yaml.parse(publication);
      for (const [jobId, actionId] of [
        ['authority', 'ci-release-authority'], ['source-gate', 'ci-rust-source-gate'],
        ['build', 'ci-rust-release-build'], ['assemble', 'ci-release-assembly'], ['publish', 'ci-release-publisher'],
      ]) {
        const step = provider.jobs[jobId].steps.find(item => item.uses === `a3-suite/a3-ci-github/actions/${actionId}@${actionRef}`);
        expect(step, actionId).toBeDefined();
        expect(step.if, actionId).toBeUndefined();
        expect(step.run, actionId).toBeUndefined();
      }
      expect(publication).not.toMatch(/authority_owner|publish_owner|publication_notes|release_identity|CI_RELEASE_IMPLEMENTATION (?:==|!=)/);
      expect(provider.jobs.authority.outputs).toMatchObject({
        source_sha: '${{ steps.authority.outputs.source_sha }}',
        version: '${{ steps.authority.outputs.version }}',
        target_identity: '${{ steps.authority.outputs.target_identity }}',
        approval_id: "${{ steps.authority.outputs['approval-id'] }}",
        approval_body_sha256: "${{ steps.authority.outputs['body-sha256'] }}",
      });
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
            values['inputs.supplemental_release_asset_implementation'] = 'owner-adapter';
            values['inputs.supplemental_release_asset_config_path'] = '__unset__';
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
        new RegExp(`actions/ci-release-supplemental-asset@${actionRef}`),
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
        new RegExp(`actions/ci-release-supplemental-asset@${actionRef}`),
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
      includesAll(stepContaining(publicationJob, '- id: publish'), [/GH_TOKEN: \$\{\{ github\.token \}\}/, new RegExp(`ci-release-publisher@${actionRef}`)]);
      expect(stepContaining(publicationJob, '- id: publish')).not.toMatch(/ci-release-publish\.sh|CI_GITHUB_TOKEN/);
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
    const referenceFixture = (t) => {
      mkdirSync(path.join(root, 'tmp'), { recursive: true });
      const fixture = mkdtempSync(path.join(root, 'tmp/action-reference-gate-'));
      t.onTestFinished(() => rmSync(fixture, { recursive: true, force: true }));
      execFileSync('git', ['clone', '--shared', '--no-checkout', root, fixture], { stdio: 'pipe' });
      mkdirSync(path.join(fixture, 'actions'));
      for (const relative of [registryPath, ...repositorySnapshot(root).targets]) {
        mkdirSync(path.dirname(path.join(fixture, relative)), { recursive: true });
        writeFileSync(path.join(fixture, relative), read(relative));
      }
      return fixture;
    };

    const pinOldActionReferences = (fixture) => {
      const old = execFileSync('git', ['rev-parse', 'refs/tags/v0.2.0^{commit}'], { cwd: fixture, encoding: 'utf8' }).trim();
      for (const relative of [registryPath, ...repositorySnapshot(fixture).targets]) {
        writeFileSync(path.join(fixture, relative), readFileSync(path.join(fixture, relative), 'utf8').replaceAll(actionRef, old));
      }
      const registry = yaml.parse(readFileSync(path.join(fixture, registryPath), 'utf8'));
      registry.actionization.implementationSource.releaseTag = 'v0.2.0';
      writeFileSync(path.join(fixture, registryPath), yaml.stringify(registry));
    };

    // contract_id: contract.ci-quality-adapter.outputs
    // integration_id: repository-quality-action-reference-contracts
    test('fixed quality Action references preserve rejection contracts and expose old registry pins', (t) => {
      // Arrange
      const fixture = referenceFixture(t);
      const current = checkRepository(fixture);
      // Act
      const accepted = verifyActionReferenceContracts(fixture, current.actionReferences, current.snapshot);
      // Assert
      const quality = accepted.observations.filter(({ case: name }) => name.startsWith('quality-'));
      expect(quality.map(({ case: name }) => name)).toEqual(['quality-custom', 'quality-reserved']);
      expect(quality.every(({ passed }) => passed)).toBe(true);
      // Arrange
      pinOldActionReferences(fixture);
      const pinned = checkRepository(fixture);
      // Act
      const rejected = verifyActionReferenceContracts(fixture, pinned.actionReferences, pinned.snapshot);
      // Assert
      expect(pinned.diagnostics).toEqual([]);
      expect(rejected.diagnostics.filter((diagnostic) => diagnostic.includes('/ci-quality-adapter@'))).toHaveLength(1);
      expect(rejected.diagnostics.join('\n')).toContain('quality-reserved');
    });

    // contract_id: contract.ci-release-publication-control.outputs
    // integration_id: repository-publication-action-reference-contracts
    test('fixed publication Action references require owner decisions and expose old registry pins', (t) => {
      // Arrange
      const fixture = referenceFixture(t);
      const current = checkRepository(fixture);
      // Act
      const accepted = verifyActionReferenceContracts(fixture, current.actionReferences, current.snapshot);
      // Assert
      const publication = accepted.observations.filter(({ case: name }) => name.startsWith('publication-'));
      expect(publication.map(({ case: name }) => name)).toEqual(['publication-valid', 'publication-INPUT_RELEASE-VERSION', 'publication-INPUT_TARGET-IDENTITY', 'publication-owner-decision']);
      expect(publication.every(({ passed }) => passed)).toBe(true);
      // Arrange
      pinOldActionReferences(fixture);
      const pinned = checkRepository(fixture);
      // Act
      const rejected = verifyActionReferenceContracts(fixture, pinned.actionReferences, pinned.snapshot);
      // Assert
      expect(pinned.diagnostics).toEqual([]);
      expect(rejected.diagnostics.filter((diagnostic) => diagnostic.includes('/ci-release-publication-control@'))).toHaveLength(1);
      expect(rejected.diagnostics.join('\n')).toContain('publication-owner-decision');
    });

    // evidence_role: supplemental
    // integration_id: repository-action-reference-gate
    test('provider reference gate rejects old contracts and unavailable Action bindings', (t) => {
      // Arrange
      const fixture = referenceFixture(t);
      const current = checkRepository(fixture);
      // Act
      const accepted = verifyActionReferenceContracts(fixture, current.actionReferences, current.snapshot);
      // Assert
      expect(accepted.observations).toHaveLength(6);
      expect(accepted.diagnostics).toEqual([]);
      // Arrange
      pinOldActionReferences(fixture);
      const command = (...args) => spawnSync(process.execPath, [path.join(root, 'runtime/repository/check-provider-references.mjs'), '--contracts', ...args], { cwd: fixture, encoding: 'utf8' });
      // Act
      const strict = command();
      const preparation = command('--preparation');
      // Assert
      expect(strict.status, strict.stderr).toBe(1);
      expect(preparation.status, preparation.stderr).toBe(1);
      expect(JSON.parse(preparation.stdout).preparationOnly).toBe(false);
      expect(JSON.parse(preparation.stdout).connection.diagnostics).toHaveLength(2);
      // Arrange
      const registry = yaml.parse(readFileSync(path.join(fixture, registryPath), 'utf8'));
      registry.actionization.availabilityGate.status = 'pending-release';
      registry.actionization.targets.forEach((target) => { target.status = 'pending-release'; });
      writeFileSync(path.join(fixture, registryPath), yaml.stringify(registry));
      // Act
      const activation = command('--preparation');
      // Assert
      expect(activation.status, activation.stderr).toBe(1);
      expect(JSON.parse(activation.stdout).diagnostics.join('\n')).toMatch(/available|registered/);
      expect(() => verifyActionReferenceContracts(fixture, [])).toThrow(/Required Action contract reference/);
      expect(() => verifyActionReferenceContracts(fixture, [{ uses: `a3-suite/a3-ci-github/actions/ci-quality-adapter@${'f'.repeat(40)}` }, ...current.actionReferences.filter(({ uses }) => uses.includes('/ci-release-publication-control@'))])).toThrow();
    });

    // integration_id: repository-action-reference-contracts
    test.each([
      '.github/workflows/ci-release-publication.yml',
      'workflows/release/release-publication-caller.yml',
      'actions/ci-release-publisher/action.yml',
    ])('fixed Action metadata rejects invalid paths in %s', (relative) => {
      // Arrange
      const snapshot = repositorySnapshot(root);
      const step = { uses: `a3-suite/a3-ci-github/actions/ci-release-publisher/not-an-action@${actionRef}` };
      const document = relative.startsWith('actions/') ? { runs: { using: 'composite', steps: [step] } } : { jobs: { publish: { steps: [step] } } };
      // Act
      const result = checkActionReferences(root, { ...snapshot, targets: [relative], read: () => yaml.stringify(document) });
      // Assert
      expect(result.diagnostics.join('\n')).toContain('invalid first-party Action path');
    });

    // integration_id: repository-action-reference-contracts
    test.each(['const = ;', "require('a3-reference-test-missing-module');"])('preparation gate rejects an unexecutable fixed bundle: %s', (bundle) => {
      // Arrange
      const fixture = referenceFixture({ onTestFinished });
      const git = (...args) => execFileSync('git', args, { cwd: fixture, encoding: 'utf8', stdio: 'pipe' }).trim();
      const entrypoint = 'actions/ci-quality-adapter/dist/index.js';
      git('read-tree', 'HEAD');
      mkdirSync(path.dirname(path.join(fixture, entrypoint)), { recursive: true });
      writeFileSync(path.join(fixture, entrypoint), bundle);
      writeFileSync(path.join(fixture, 'VERSION'), '999.0.0\n');
      git('add', entrypoint, 'VERSION');
      const hooks = path.join(fixture, 'tmp/empty-hooks');
      mkdirSync(hooks, { recursive: true });
      git('-c', 'user.name=Reference Test', '-c', 'user.email=reference-test@example.invalid', '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${hooks}`, 'commit', '-m', 'Synthetic unavailable bundle');
      const sha = git('rev-parse', 'HEAD');
      const tag = 'v999.0.0';
      git('-c', 'user.name=Reference Test', '-c', 'user.email=reference-test@example.invalid', 'tag', '-a', tag, '-m', 'Synthetic unavailable bundle');
      for (const relative of [registryPath, ...repositorySnapshot(fixture).targets]) {
        writeFileSync(path.join(fixture, relative), readFileSync(path.join(fixture, relative), 'utf8').replaceAll(actionRef, sha));
      }
      const registry = yaml.parse(readFileSync(path.join(fixture, registryPath), 'utf8'));
      registry.actionization.implementationSource.releaseTag = tag;
      writeFileSync(path.join(fixture, registryPath), yaml.stringify(registry));
      // Act
      const result = spawnSync(process.execPath, [path.join(root, 'runtime/repository/check-provider-references.mjs'), '--contracts', '--preparation'], { cwd: fixture, encoding: 'utf8' });
      // Assert
      expect(result.status, result.stdout).toBe(2);
      expect(result.stderr).toContain('Action contract execution unavailable');
    });

    // integration_id: repository-action-reference-contracts
    test('fixed Action metadata rejects input output and installer binding drift', () => {
      // Arrange
      const snapshot = repositorySnapshot(root);
      const relative = '.github/workflows/ci-release-publication.yml';
      const workflow = yaml.parse(snapshot.read(relative));
      const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
      const control = steps.find((step) => step.uses?.includes('/ci-release-publication-control@'));
      delete control.with.operation;
      control.id = 'contract-control';
      control.with['undeclared-input'] = 'value';
      const installer = steps.find((step) => step.env?.A3_INSTALLER_PROVIDER_REVISION);
      installer.env.A3_INSTALLER_PROVIDER_REVISION = 'f'.repeat(40);
      const job = Object.values(workflow.jobs).find((job) => job.steps?.includes(control));
      job.steps.push({ run: `echo \"${'${{'} steps.${control.id}.outputs.undeclared-output }}\"` });
      // Act
      const result = checkActionReferences(root, { ...snapshot, read: (target) => target === relative ? yaml.stringify(workflow) : snapshot.read(target) });
      // Assert
      expect(result.interfaceDiagnostics.join('\n')).toContain('missing required Action input operation');
      expect(result.interfaceDiagnostics.join('\n')).toContain('undeclared Action input undeclared-input');
      expect(result.interfaceDiagnostics.join('\n')).toContain('undeclared Action output undeclared-output');
      expect(result.diagnostics.join('\n')).toContain('installer provider revision differs');
    });

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
      const installerWindows = jobBlock(workflow, 'installer-windows');
      const installerMacos = jobBlock(workflow, 'installer-macos');
      const installerHandoff = jobBlock(workflow, 'installer-handoff');
      const aggregate = jobBlock(workflow, 'contract');
      expect(linux).toMatch(/^    name: CI Action contract \/ Linux$/m);
      includesAll(windows, [
        /^    name: Rust release contract \/ Windows$/m,
        /^    runs-on: windows-2025$/m,
        /--testNamePattern="PowerShell\|Windows"/,
      ]);
      includesAll(installerWindows, [
        /^    name: Installer contract \/ Windows$/m,
        /^    runs-on: windows-2025$/m,
        /actions\/setup-python@[0-9a-f]{40}/,
        /python-version: '3\.12'/,
        /python -m unittest discover -s runtime\/installer\/tests -p test_build_installer\.py -v/,
        /python -m unittest discover -s runtime\/installer\/tests -p test_runtime_installer\.py -k test_windows -v/,
        /name: Test native Windows installer safety \/ Windows PowerShell 5\.1\n\s+shell: powershell\n\s+env:\n\s+CI_INSTALLER_POWERSHELL: powershell/,
        /name: Test native Windows installer safety \/ PowerShell 7\n\s+shell: pwsh\n\s+env:\n\s+CI_INSTALLER_POWERSHELL: pwsh/,
      ]);
      for (const native of [installerWindows, installerMacos]) {
        expect(native).toContain('npm test -- actions/ci-release-supplemental-asset/tests/standard-installer.test.ts');
        expect(native).toContain('npm ci --ignore-scripts --no-audit --no-fund');
      }
      includesAll(installerMacos, [
        /^    runs-on: macos-14$/m,
        /test "\$\(uname -m\)" = arm64/,
        /python3 -m unittest discover -s runtime\/installer\/tests -p 'test_\*\.py' -v/,
      ]);
      includesAll(linux, [
        /npm run test:coverage:installer/,
        /name: installer-python-source-coverage/,
        /path: tests\/tmp\/coverage\/installer\/run-\*\/coverage\.json/,
        /if-no-files-found: error/,
      ]);
      expect(new Set(summaryNeeds(aggregate))).toStrictEqual(new Set(['contract-linux', 'rust-windows', 'installer-windows', 'installer-macos', 'installer-handoff']));
      includesAll(installerHandoff, [
        /needs: \[installer-windows, installer-macos\]/,
        /producer: installer-windows/,
        /producer: installer-macos/,
        /uses: \.\/actions\/ci-handoff-integrity/,
        /source-sha: \$\{\{ needs\[matrix\.producer\]\.outputs\.source-sha \}\}/,
      ]);
      includesAll(aggregate, [
        /^    name: CI Action contract \/ hosted$/m,
        /^    if: always\(\)$/m,
        /test "\$LINUX_RESULT" = success/,
        /test "\$WINDOWS_RESULT" = success/,
        /test "\$INSTALLER_WINDOWS_RESULT" = success/,
        /test "\$INSTALLER_MACOS_RESULT" = success/,
        /test "\$INSTALLER_HANDOFF_RESULT" = success/,
        /INSTALLER_MACOS_RESULT: \$\{\{ needs\.installer-macos\.result \}\}/,
        /INSTALLER_WINDOWS_RESULT: \$\{\{ needs\.installer-windows\.result \}\}/,
      ]);
    });

    // integration_id: repository-quality-delivery-regression
    test('provider reference gate rejects first-party binding drift', () => {
      // Arrange
      const binding = { repository: 'a3-suite/a3-ci-github', exactRef: actionRef };
      const workflow = yaml.stringify({ jobs: { verify: { steps: [{ uses: `a3-suite/a3-ci-github/actions/ci-quality-adapter@${'f'.repeat(40)}` }] } } });
      // Act
      const diagnostics = checkProviderReferences(workflow, '.github/workflows/ci-quality.yml', new Map(), binding);
      // Assert
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toContain('first-party');
    });

    // integration_id: repository-quality-delivery-regression
    test('repository workflow provider actions use registry-approved pins', () => {
      const entries = yaml.parse(read('skills/ci-github/references/ci-github-preset-assets.reference.yml')).providerActions.entries;
      const approved = new Map(entries.map((entry) => [entry.action, entry.commitSha]));
      for (const relative of ['.github/workflows/quality-gate.yml', '.github/workflows/release.yml', 'actions/ci-quality-toolchain/action.yml']) {
        expect(checkProviderReferences(read(relative), relative, approved)).toEqual([]);
      }
      const sha = approved.get('actions/checkout');
      const workflow = (uses) => yaml.stringify({ jobs: { verify: { steps: [{ uses }] } } });
      for (const reference of ['actions/checkout@<commit-sha>', 'actions/checkout@v7', `actions/checkout@${'f'.repeat(40)}`, 42]) {
        expect(checkProviderReferences(workflow(reference), '.github/workflows/ci-quality.yml', approved)).toHaveLength(1);
      }
      expect(checkProviderReferences(workflow(`actions/checkout@${sha}`), '.github/workflows/ci-quality.yml', approved)).toEqual([]);
      expect(checkProviderReferences('jobs: {call: {uses: owner/repo/.github/workflows/check.yml@main}}', '.github/workflows/ci-quality.yml', approved)).toHaveLength(1);
      expect(checkProviderReferences('runs: {using: composite, steps: [{uses: actions/checkout@main}]}', 'actions/example/action.yml', approved)).toHaveLength(1);
      expect(checkProviderReferences(workflow('./actions/example'), '.github/workflows/ci-quality.yml', approved)).toEqual([]);
      expect(() => checkProviderReferences('jobs: [', '.github/workflows/check.yml', approved)).toThrow();
      const checked = checkRepository(root);
      expect(checked.diagnostics).toEqual([]);
      expect(checked.interfaceDiagnostics).toEqual([]);
      const lintProfiles = yaml.parse(read('a3-lint.repository.yaml')).project.rule_sets;
      const profile = (id) => lintProfiles.find((entry) => entry.id === id);
      expect(lintProfiles.every((entry) => !entry.root.includes('${') && entry.lib_dir === 'lint-rules/a3-lint/shared')).toBe(true);
      const externalProfiles = yaml.parse(read('a3-lint.yaml')).project.rule_sets;
      expect(externalProfiles.every((entry) => entry.root.startsWith('${skills_root}/'))).toBe(true);
      expect(externalProfiles.some((entry) => lintProfiles.some((own) => own.id === entry.id))).toBe(false);
      const lintScript = read('runtime/repository/lint-repository.sh');
      expect(JSON.parse(read('package.json')).scripts['lint:repository']).toBe('bash runtime/repository/lint-repository.sh');
      for (const command of ['--config a3-lint.repository.yaml', '--only-rule-set provider-workflows', '--only-rule-set repository-workflows', '--only-rule-set repository-actions', 'node tests/a3-lint-rule-regression.mjs', 'npm test -- tests/workflow-contracts.test.mjs']) expect(lintScript).toContain(command);
      expect(lintScript).toContain('set -euo pipefail');
      for (const forbidden of ['--version', '--download', 'releases/download', 'curl ', '0.7.0', '0.8.0']) expect(lintScript).not.toContain(forbidden);
      expect(lintScript).toContain('assert.equal(report.checked_targets, Number(process.argv[1])');
      expect(lintScript).toContain('assert.deepEqual(report.runtime_errors, [])');

      expect(profile('skill-ci-github').include).toContain('**/ci_github_workflow_*.lua');
      for (const id of ['provider-workflows', 'repository-workflows']) {
        expect(profile(id).root).toBe('lint-rules/a3-lint');
        for (const rule of ['external_action_full_sha', 'immutable_image', 'no_moving_runner', 'no_privileged_cancel', 'no_untrusted_run_expression']) {
          expect(profile(id).include).toContain(`**/ci_github_workflow_${rule}.lua`);
        }
        expect(profile(id).include).not.toContain('**/ci_github_workflow_name_matches_file.lua');
        expect(profile(id).include).not.toContain('**/ci_github_workflow_no_long_inline_script.lua');
      }
      expect(profile('repository-workflows').include).toContain('**/ci_github_workflow_no_untrusted_runner_selector.lua');
      const assertProviderRunners = (name, document) => {
        for (const [jobId, job] of Object.entries(document.jobs)) {
          const matrixJob = (name === 'ci-quality-platforms' && jobId === 'platform')
            || (name === 'ci-release-publication' && jobId === 'build');
          const expected = name === 'ci-package-preparation' ? 'ubuntu-24.04'
            : matrixJob ? '${{ matrix.runner }}' : '${{ inputs.runner }}';
          expect(job['runs-on']).toBe(expected);
          if (expected === '${{ inputs.runner }}') {
            expect(document.on.workflow_call.inputs.runner.type).toBe('string');
            expect(document.on.workflow_call.inputs.runner.required).toBe(true);
          }
        }
      };
      for (const name of ['ci-quality', 'ci-quality-platforms', 'ci-package-preparation', 'ci-release-publication', 'ci-package-publication']) {
        const document = yaml.parse(read(`.github/workflows/${name}.yml`));
        assertProviderRunners(name, document);
        for (const selector of ['${{ github.event.pull_request.head.ref }}', '${{ inputs.other }}']) {
          const copy = structuredClone(document);
          Object.values(copy.jobs)[0]['runs-on'] = selector;
          expect(() => assertProviderRunners(name, copy)).toThrow();
        }
        const addedJob = structuredClone(document);
        addedJob.jobs.injected = { 'runs-on': '${{ github.head_ref }}', steps: [] };
        expect(() => assertProviderRunners(name, addedJob)).toThrow();
      }
      const generation = yaml.parse(read('.github/workflows/release.yml')).jobs['prepare-distribution'].steps
        .find((step) => step.name === 'Generate selective distribution Release assets');
      expect(generation.env).toEqual({ DISTRIBUTION_SOURCE_SHA: '${{ steps.release-identity.outputs.source_sha }}', DISTRIBUTION_RELEASE_TAG: '${{ inputs.release-tag }}' });
      expect(generation.run).toContain('--source-revision "$DISTRIBUTION_SOURCE_SHA"');
      expect(generation.run).toContain('--release-tag "$DISTRIBUTION_RELEASE_TAG"');
      expect(generation.run).not.toContain('${{');
      const assertRequiredGate = (document, release) => {
        const jobId = release ? 'prepare-distribution' : 'contract-linux';
        const job = document.jobs[jobId];
        expect(job).toBeDefined();
        expect(job.if).toBeUndefined();
        expect(job['continue-on-error'] ?? false).toBe(false);
        const testCommand = 'npm test -- tests/workflow-contracts.test.mjs runtime/distribution/tests/selective-distribution.test.mjs runtime/repository/tests/single-release-binding.test.mjs';
        const commands = release ? ['provider-binding', testCommand] : ['npm run lint:provider'];
        const gates = job.steps.map((step, index) => ({ step, index }))
          .filter(({ step }) => commands.includes(step.id ?? step.run?.trim()));
        expect(gates.map(({ step }) => step.id ?? step.run.trim()).sort()).toEqual([...commands].sort());
        if (release) {
          const binding = gates.find(({ step }) => step.id === 'provider-binding').step;
          expect(binding.run).toContain('set -euo pipefail');
          expect(binding.run).toContain('check-provider-references.mjs --contracts --release-tag "$RELEASE_TAG"');
          expect(binding.run).not.toContain('|| true');
          expect(binding.env.RELEASE_TAG).toBe('${{ inputs.release-tag }}');
        }
        expect(job.steps.some((step) => step.run?.includes('lint:repository'))).toBe(false);
        for (const { step } of gates) {
          expect(step.if).toBeUndefined();
          expect(step['continue-on-error'] ?? false).toBe(false);
        }
        const index = Math.max(...gates.map((gate) => gate.index));
        const protectedCommand = release ? 'runtime/distribution/generate-distribution-release.ts' : 'tests/workflow-contracts.test.mjs';
        const protectedIndex = job.steps.findIndex((entry) => entry.run?.includes(protectedCommand));
        expect(protectedIndex).toBeGreaterThan(index);
        if (release) {
          const publish = document.jobs['publish-distribution'];
          expect([publish.needs].flat()).toContain('prepare-distribution');
          expect(publish.if).toBeUndefined();
          expect(publish['continue-on-error'] ?? false).toBe(false);
        }
      };
      for (const [relative, release] of [['.github/workflows/quality-gate.yml', false], ['.github/workflows/release.yml', true]]) {
        const document = yaml.parse(read(relative));
        assertRequiredGate(document, release);
        const jobId = release ? 'prepare-distribution' : 'contract-linux';
        for (const gateCommand of release ? ['provider-binding', 'npm test -- tests/workflow-contracts.test.mjs runtime/distribution/tests/selective-distribution.test.mjs runtime/repository/tests/single-release-binding.test.mjs'] : ['npm run lint:provider']) {
          const gateIndex = document.jobs[jobId].steps.findIndex((step) => (step.id ?? step.run) === gateCommand);
          const mutations = [
            (copy) => copy.jobs[jobId].steps.splice(gateIndex, 1),
            (copy) => { copy.jobs[jobId].steps[gateIndex].if = false; },
            (copy) => { copy.jobs[jobId].steps[gateIndex]['continue-on-error'] = true; },
            (copy) => { copy.jobs[jobId]['continue-on-error'] = true; },
            (copy) => { copy.jobs[jobId].if = false; },
            (copy) => { copy.jobs[jobId].steps[gateIndex].run += ' || true'; },
            (copy) => copy.jobs[jobId].steps.push(...copy.jobs[jobId].steps.splice(gateIndex, 1)),
            ...(release ? [
              (copy) => { copy.jobs['publish-distribution'].needs = []; },
              (copy) => { copy.jobs['publish-distribution'].if = 'always()'; },
              (copy) => { copy.jobs['publish-distribution']['continue-on-error'] = true; },
            ] : []),
          ];
          for (const mutate of mutations) {
            const copy = structuredClone(document);
            mutate(copy);
            expect(() => assertRequiredGate(copy, release)).toThrow();
          }
        }
      }
      mkdirSync(path.join(root, 'tmp'), { recursive: true });
      const failureRoot = mkdtempSync(path.join(root, 'tmp/repository-lint-failure-'));
      try {
        const binary = path.join(failureRoot, 'fake-lint');
        const calls = path.join(failureRoot, 'calls');
        writeFileSync(binary, `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nappendFileSync(process.env.LINT_CALLS, process.argv.slice(2).join(' ') + '\\n');\nif (process.argv[2] === '--version') console.log(process.env.LINT_VERSION ?? 'a3-lint 0.8.0');\nelse console.log(process.env.LINT_REPORT);\nprocess.exitCode = Number(process.argv[2] === '--version' ? process.env.LINT_VERSION_EXIT ?? 0 : process.env.LINT_LINT_EXIT ?? 0);\n`, { mode: 0o755 });
        const report = { checked_targets: 5, diagnostics: [], runtime_errors: [], trace: { execution: [{ kind: 'rule_executed' }] } };
        const cases = [
          { LINT_LINT_EXIT: '1' },
          { LINT_REPORT: '{' },
          { LINT_REPORT: JSON.stringify({ ...report, checked_targets: 0 }) },
          { LINT_REPORT: JSON.stringify({ ...report, diagnostics: [{ code: 'violation' }] }) },
          { LINT_REPORT: JSON.stringify({ ...report, runtime_errors: [{ code: 'runtime-precondition-failure' }] }) },
          { LINT_REPORT: JSON.stringify({ ...report, trace: { execution: [] } }) },
          { A3_LINT_BIN: path.join(failureRoot, 'missing-lint') },
        ];
        for (const environment of cases) {
          writeFileSync(calls, '');
          const result = spawnSync('bash', ['runtime/repository/lint-repository.sh'], { cwd: root, encoding: 'utf8',
            env: { ...process.env, A3_LINT_BIN: binary, LINT_CALLS: calls, LINT_REPORT: JSON.stringify(report), ...environment } });
          expect(result.status).not.toBe(0);
          expect(readFileSync(calls, 'utf8').trim().split('\n').length, JSON.stringify(environment) + readFileSync(calls, 'utf8')).toBeLessThanOrEqual(2);
          expect(result.stdout).not.toContain('a3-lint fixture groups passed');
          expect(readFileSync(calls, 'utf8')).not.toContain('--version');
        }
      } finally { rmSync(failureRoot, { recursive: true, force: true }); }
      const fixture = mkdtempSync(path.join(root, 'tmp/provider-reference-stage-'));
      const git = (...args) => execFileSync('git', args, { cwd: fixture, encoding: 'utf8', stdio: 'pipe' });
      try {
        git('init');
        const registryPath = 'skills/ci-github/references/ci-github-preset-assets.reference.yml';
        mkdirSync(path.join(fixture, path.dirname(registryPath)), { recursive: true });
        writeFileSync(path.join(fixture, registryPath), read(registryPath));
        mkdirSync(path.join(fixture, '.github/workflows'), { recursive: true });
        const callees = ['ci-quality', 'ci-quality-platforms', 'ci-package-preparation', 'ci-release-publication', 'ci-package-publication'];
        for (const name of callees) writeFileSync(path.join(fixture, `.github/workflows/${name}.yml`), workflow(`actions/checkout@${sha}`));
        git('add', '.');
        writeFileSync(path.join(fixture, '.github/workflows/ci-quality.yml'), workflow('actions/checkout@<commit-sha>'));
        expect(checkRepository(fixture, true).diagnostics).toEqual([]);
        git('add', '.');
        expect(checkRepository(fixture, true).diagnostics).toHaveLength(1);
        mkdirSync(path.join(fixture, 'actions'));
        const cli = (...args) => spawnSync(process.execPath,
          [path.join(root, 'runtime/repository/check-provider-references.mjs'), ...args],
          { cwd: fixture, encoding: 'utf8' });
        // Act
        const rejectedReference = cli();
        // Assert
        expect(rejectedReference.status).toBe(1);
        expect(JSON.parse(rejectedReference.stdout).diagnostics).toHaveLength(1);
        expect(rejectedReference.stderr).toBe('');
        // Arrange
        writeFileSync(path.join(fixture, '.github/workflows/ci-quality.yml'), workflow(`actions/checkout@${sha}`));
        const validRegistry = read(registryPath);
        const duplicate = yaml.parse(validRegistry);
        duplicate.providerActions.entries.push(duplicate.providerActions.entries[0]);
        const invalidPin = yaml.parse(validRegistry);
        invalidPin.providerActions.entries[0].commitSha = 'main';
        const registryCases = [
          ['YAML syntax', 'providerActions: [', /Invalid provider registry YAML/],
          ['duplicate action', yaml.stringify(duplicate), /Invalid provider pin registry/],
          ['invalid SHA', yaml.stringify(invalidPin), /Invalid provider pin registry/],
        ];
        for (const [label, content, diagnostic] of registryCases) {
          writeFileSync(path.join(fixture, registryPath), content);
          // Act
          const result = cli();
          // Assert
          expect(() => checkRepository(fixture), label).toThrow(diagnostic);
          expect(result.status, label).toBe(2);
          expect(result.stdout, label).toBe('');
          expect(result.stderr, label).toMatch(diagnostic);
        }
        // Arrange
        writeFileSync(path.join(fixture, registryPath), validRegistry);
        const missingCallee = path.join(fixture, '.github/workflows/ci-quality.yml');
        rmSync(missingCallee);
        // Act
        const missing = cli();
        // Assert
        expect(missing.status).toBe(2);
        expect(missing.stdout).toBe('');
        expect(missing.stderr).toMatch(/Missing provider callee: ci-quality/);
        // Arrange
        writeFileSync(missingCallee, workflow(`actions/checkout@${sha}`));
        // Act
        const accepted = cli();
        const unknownArgument = cli('--invalid');
        // Assert
        expect(accepted.status, accepted.stderr).toBe(0);
        expect(JSON.parse(accepted.stdout).diagnostics).toEqual([]);
        expect(unknownArgument.status).toBe(2);
        expect(unknownArgument.stdout).toBe('');
        expect(unknownArgument.stderr).toMatch(/Usage:/);
      } finally {
        rmSync(fixture, { recursive: true, force: true });
        expect(existsSync(fixture)).toBe(false);
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
        expect(call[0].uses).toBe(`a3-suite/a3-ci-github/actions/ci-quality-toolchain@${actionRef}`);
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
