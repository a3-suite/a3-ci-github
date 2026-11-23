import { existsSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import yaml from 'yaml';
import { checkProviderReferences, checkRepository, registryPath, repositorySnapshot } from '../runtime/repository/check-provider-references.mjs';
import { verifyActionReferenceContracts } from '../runtime/repository/verify-action-reference-contracts.mjs';
import path from 'node:path';
import { afterEach, beforeEach, test, describe, expect, onTestFinished, vi } from 'vitest';
import { createDocsOnlyMatcher, detectChangeScope } from '../actions/ci-change-scope/src/scope.ts';
import { materializePublishVersion } from '../actions/ci-publish-version/src/materialize.ts';
import { spawnTimeoutMs, mediumSpawnTimeoutMs, slowSpawnTimeoutMs, root, read, actionRef, includesAll, jobBlock, referenceFixture, pinOldActionReferences } from "./workflow-contracts.fixtures.mjs";

const readSummaryStatus = (output) =>
  readFileSync(output, 'utf8').match(/^status<<([^\r\n]+)\r?\n([^\r\n]+)\r?\n\1$/m)?.[2];

describe("workflow-contracts", () => {
  describe("quality-workflow-contract", () => {
    // evidence_role: supplemental
    // The fetch scope and the fail-open handling of the comparison preparation are implementation efficiency details that no contract guarantee covers.
    // flow_id: quality-workflow-contract
    test('quality diff preparation fetches only the comparison commit and preserves fail-open scope', () => {
      // Arrange
      mkdirSync(path.join(root, 'tmp'), { recursive: true });
      const directory = mkdtempSync(path.join(root, 'tmp/quality-diff-'));
      const origin = path.join(directory, 'origin');
      mkdirSync(origin);
      const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: spawnTimeoutMs }).trim();
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
            const before = spawnSync('git', ['cat-file', '-e', `${base}^{commit}`], { cwd: consumer, timeout: spawnTimeoutMs });
            expect(before.error).toBeUndefined();
            expect(before.status).not.toBe(0);
            const trace = path.join(consumer, 'fetch.trace');
            // Act
            const prepared = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', preparation.run], { cwd: consumer, encoding: 'utf8', env: { ...process.env, CI_DIFF_BASE_SHA: comparison, GIT_TRACE: trace }, timeout: spawnTimeoutMs });
            const result = detectChangeScope(comparison, head, createDocsOnlyMatcher(['**/*.md']), (from, to) => execFileSync('git', ['diff', '--name-only', '-z', from, to], { cwd: consumer, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: spawnTimeoutMs }));
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
              const cached = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', preparation.run], { cwd: consumer, encoding: 'utf8', env: { ...process.env, CI_DIFF_BASE_SHA: comparison, GIT_TRACE: trace }, timeout: spawnTimeoutMs });
              // Assert
              expect(cached.status, cached.stderr).toBe(0);
              expect(readFileSync(trace, 'utf8').split('built-in: git fetch ').length - 1).toBe(1);
            }
          }
        }
      } finally { rmSync(directory, { recursive: true, force: true }); }
    });

    // flow_id: quality-workflow-contract
    test('caller summary rejects failed cancelled skipped and missing reusable results through the bundled Action', () => {
      const templates = [
        ['workflows/quality/quality-gate.yml', 'summary', 'quality'],
        ['workflows/quality/quality-gate-platforms.yml', 'platform-summary', 'platforms'],
        ['workflows/quality/quality-gate-profiles.yml', 'profiles-summary', 'quality'],
      ].map(([file, job, source]) => ({ source, template: yaml.parse(read(file)).jobs[job].steps.find((step) => step.with?.['summary-json']).with['summary-json'] }));
      mkdirSync(path.join(root, 'tmp'), { recursive: true });
      const directory = mkdtempSync(path.join(root, 'tmp/reusable-quality-summary-'));
      try {
        const output = path.join(directory, 'output');
        const outcomes = [
          ['success', 'success'],
          ['failure', 'failed'],
          ['cancelled', 'unresolved'],
          ['skipped', 'unresolved'],
          ['', 'failed'],
          ['unknown', 'unresolved'],
        ];
        for (const { source, template } of templates) for (const [result, expectedStatus] of outcomes) {
          const payload = template.replaceAll('${{ needs.' + source + '.result }}', result);
          writeFileSync(output, '');
          const run = spawnSync(process.execPath, [path.join(root, 'actions/ci-quality-summary/dist/index.js')], {
            cwd: directory, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true',
              GITHUB_OUTPUT: output,
              GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'example/project', GITHUB_RUN_ID: '1',
              'INPUT_SUMMARY-JSON': payload, 'INPUT_SUMMARY-PATH': path.join(directory, 'summary.md'),
              'INPUT_EVIDENCE-PATH': path.join(directory, 'evidence.md'),
            }, timeout: spawnTimeoutMs,
          });
          expect(run.error, `${result}: the process did not finish`).toBeUndefined();
          expect(run.status, `${result}: ${run.stderr}`).toBe(result === 'success' ? 0 : 1);
          expect(readSummaryStatus(output), `reusable result: ${JSON.stringify(result)}`).toBe(expectedStatus);
          if (result !== 'success') {
            const line = run.stderr.split('\n').find(value => value.startsWith('ci-failure-diagnostic:'));
            expect(JSON.parse(line?.slice('ci-failure-diagnostic:'.length) ?? '{}').classification)
              .toMatchObject({ stage: result === '' ? 'summary-classification' : 'summary-result' });
          }
        }
      } finally { rmSync(directory, { recursive: true, force: true }); }
    });

    // flow_id: quality-workflow-contract
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
              }, timeout: spawnTimeoutMs,
            });
            expect(result.status, `${file}: ${JSON.stringify(scenario)}: ${result.stderr}`).toBe(scenario.status);
            const outputs = existsSync(output) ? readFileSync(output, 'utf8').trim().split('\n') : [];
            if (scenario.status === 0) {
              expect(outputs).toStrictEqual([
                `root=${scenario.root}`,
                `source=${scenario.root === '.ci-base' ? 'base' : 'bootstrap'}`,
              ]);
            } else {
              expect(outputs).toStrictEqual([]);
            }
          } finally { rmSync(directory, { recursive: true, force: true }); }
        }
      }
    });
  });
});


describe("workflow-contracts", () => {
  describe("quality-workflow-contract", () => {
    // evidence_role: supplemental
    // The Cargo cache profile condition, restore and save order, pinned actions and failure isolation are caching optimizations that no contract guarantee covers.
    // flow_id: quality-workflow-contract
    test('trusted Rust quality restores the Cargo cache after path resolution and saves it after the adapter', () => {
      // Arrange
      const quality = yaml.parse(read('.github/workflows/ci-quality.yml')).jobs;
      const cachePin = yaml.parse(read(registryPath)).providerActions.entries.find(entry => entry.action === 'actions/cache').commitSha;
      const steps = quality.trusted.steps;
      const paths = steps.find(step => step.id === 'cargo-cache-paths');
      const cache = steps.find(step => step.id === 'cargo-cache');
      const adapter = steps.find(step => step.id === 'quality-adapter');
      const save = steps.find(step => /^actions\/cache\/save@/.test(step.uses ?? ''));
      const output = path.join(mkdtempSync(path.join(root, 'tmp/cargo-cache-paths-')), 'output');
      onTestFinished(() => rmSync(path.dirname(output), { recursive: true, force: true }));
      const failedOutput = `${output}-failed`;
      // Act
      const failed = spawnSync('bash', ['-c', paths.run.replace(/cargo metadata [^|]+\|/, 'false |')], {
        env: { ...process.env, GITHUB_OUTPUT: failedOutput }, encoding: 'utf8', timeout: spawnTimeoutMs,
      });
      // Assert
      expect(failed.status).not.toBe(0);
      expect(existsSync(failedOutput)).toBe(false);
      expect(paths['continue-on-error']).toBe(true);
      expect(adapter.if).toBe("steps.change-scope.outputs['run-ci'] != 'false'");
      expect(paths.if).toBe("steps.change-scope.outputs['run-ci'] != 'false' && env.CI_LANGUAGE_PROFILE == 'rust'");
      expect(cache.if).toBe("steps.cargo-cache-paths.outcome == 'success'");
      expect(cache.uses).toBe(`actions/cache/restore@${cachePin}`);
      expect(save.uses).toBe(`actions/cache/save@${cachePin}`);
      expect(steps.filter(step => /^actions\/cache(?:\/[a-z-]+)?@/.test(step.uses ?? ''))).toStrictEqual([cache, save]);
      expect(steps.indexOf(cache)).toBeLessThan(steps.indexOf(adapter));
      expect(steps.indexOf(adapter)).toBeLessThan(steps.indexOf(save));
    });

    // flow_id: quality-workflow-contract
    test('trusted Rust quality caches the Cargo registry and normalized target directory under a toolchain and lock key', () => {
      // Arrange
      const steps = yaml.parse(read('.github/workflows/ci-quality.yml')).jobs.trusted.steps;
      const paths = steps.find(step => step.id === 'cargo-cache-paths');
      const cache = steps.find(step => step.id === 'cargo-cache');
      const save = steps.find(step => /^actions\/cache\/save@/.test(step.uses ?? ''));
      const output = path.join(mkdtempSync(path.join(root, 'tmp/cargo-cache-target-')), 'output');
      onTestFinished(() => rmSync(path.dirname(output), { recursive: true, force: true }));
      // Act + Assert
      execFileSync('bash', ['-c', paths.run.replace(/cargo metadata [^|]+\|/, 'printf %s "$METADATA" |')], {
        env: { ...process.env, METADATA: JSON.stringify({ target_directory: 'D:\\a\\repo\\target' }), GITHUB_OUTPUT: output }, timeout: spawnTimeoutMs,
      });
      expect(readFileSync(output, 'utf8')).toBe('target=D:/a/repo/target\n');
      expect(cache.with.path.split('\n').filter(Boolean)).toStrictEqual([
        '~/.cargo/registry/index', '~/.cargo/registry/cache', '~/.cargo/git/db',
        '${{ steps.cargo-cache-paths.outputs.target }}', '!${{ steps.cargo-cache-paths.outputs.target }}/*/incremental',
      ]);
      expect(save.with.path).toBe(cache.with.path);
      expect(save.with.key).toBe('${{ steps.cargo-cache.outputs.cache-primary-key }}');
      for (const part of ['runner.os', 'runner.arch', 'steps.quality-toolchain.outputs.resolved-toolchain-version', 'hashFiles(env.CI_CARGO_LOCK_PATH)']) expect(cache.with.key).toContain(part);
      expect(cache.with.key.startsWith(cache.with['restore-keys'])).toBe(true);
    });

    const platformSummaryCases = [
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

    // flow_id: quality-workflow-contract
    test('platform summary scripts preserve docs-only failed cancelled and missing outcomes', () => {
      const summary = yaml.parse(read('.github/workflows/ci-quality-platforms.yml')).jobs['platform-summary'];
      const enforce = summary.steps.find((step) => step.name === 'Enforce required platform results').run;
      const build = summary.steps.find((step) => step.id === 'platform-summary').run;
      mkdirSync(path.join(root, 'tmp'), { recursive: true });
      const directory = mkdtempSync(path.join(root, 'tmp/platform-summary-'));
      try {
        for (const [resolve, platform, runCi, expected, status, accepted] of platformSummaryCases) {
          const output = path.join(directory, 'output');
          writeFileSync(output, '');
          const env = { ...process.env, RESOLVE_RESULT: resolve, PLATFORM_RESULT: platform,
            RUN_CI: runCi, EXPECTED_PLATFORMS: expected, WORKFLOW_RUN_URL: 'https://github.com/example/project/actions/runs/1', GITHUB_OUTPUT: output };
          const enforcement = spawnSync('bash', ['-c', enforce], { cwd: directory, env, encoding: 'utf8', timeout: spawnTimeoutMs });
          const result = spawnSync('bash', ['-c', build], { cwd: directory, env, encoding: 'utf8', timeout: spawnTimeoutMs });
          expect(result.status, result.stderr).toBe(0);
          const payload = readFileSync(output, 'utf8').trim().slice('summary='.length);
          const records = JSON.parse(payload).jobs;
          expect(records[0].result).toBe(status);
          const actionOutput = path.join(directory, 'action-output');
          writeFileSync(actionOutput, '');
          const action = spawnSync(process.execPath, [path.join(root, 'actions/ci-quality-summary/dist/index.js')], {
            cwd: directory, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true', 'INPUT_SUMMARY-JSON': payload,
              GITHUB_OUTPUT: actionOutput,
              'INPUT_SUMMARY-PATH': path.join(directory, 'summary.md'), 'INPUT_EVIDENCE-PATH': path.join(directory, 'evidence.md') }, timeout: spawnTimeoutMs,
          });
          expect([enforcement.error, action.error], 'a process did not finish').toEqual([undefined, undefined]);
          const actionStatus = readSummaryStatus(actionOutput);
          expect(actionStatus).toBe(accepted ? 'success' : ['未実施', '判定不能'].includes(status) ? 'unresolved' : 'failed');
          expect(enforcement.status === 0 && action.status === 0, JSON.stringify({ resolve, platform, runCi, expected })).toBe(accepted);
        }
      } finally { rmSync(directory, { recursive: true, force: true }); }
    });

    // evidence_role: supplemental
    // The evidence link, the reason text and the not-applicable rows of the platform summary record are details that the unresolved-result guarantee does not observe.
    // flow_id: quality-workflow-contract
    test('platform summary record links the run and names the selected platforms', () => {
      const summary = yaml.parse(read('.github/workflows/ci-quality-platforms.yml')).jobs['platform-summary'];
      const build = summary.steps.find((step) => step.id === 'platform-summary').run;
      mkdirSync(path.join(root, 'tmp'), { recursive: true });
      const directory = mkdtempSync(path.join(root, 'tmp/platform-summary-record-'));
      try {
        for (const [resolve, platform, runCi, expected, , accepted] of platformSummaryCases) {
          const output = path.join(directory, 'output');
          writeFileSync(output, '');
          const env = { ...process.env, RESOLVE_RESULT: resolve, PLATFORM_RESULT: platform,
            RUN_CI: runCi, EXPECTED_PLATFORMS: expected, WORKFLOW_RUN_URL: 'https://github.com/example/project/actions/runs/1', GITHUB_OUTPUT: output };
          const result = spawnSync('bash', ['-c', build], { cwd: directory, env, encoding: 'utf8', timeout: spawnTimeoutMs });
          expect(result.status, result.stderr).toBe(0);
          const records = JSON.parse(readFileSync(output, 'utf8').trim().slice('summary='.length)).jobs;
          expect(records[0].evidence).toBe(env.WORKFLOW_RUN_URL);
          if (accepted && runCi === 'true') expect(records[0].reason).toBe(`all selected platforms succeeded: ${expected}`);
          if (accepted && runCi === 'false') expect(records.slice(1).map((entry) => [entry.unit, entry.result])).toStrictEqual([['platform:linux-x64', '対象外'], ['platform:macos-arm64', '対象外']]);
        }
      } finally { rmSync(directory, { recursive: true, force: true }); }
    });
  });
});




describe("workflow-contracts", () => {
  describe("package-publication-workflow-contract", () => {
    // flow_id: package-publication-workflow-contract
    test('package workflows keep their request, preparation and version plan configuration', () => {
      const request = read('workflows/package/package-publication-request.yml');
      const caller = read('workflows/package/package-publication-caller.yml');
      const preparation = read('.github/workflows/ci-package-preparation.yml');
      const publication = read('.github/workflows/ci-package-publication.yml');
      const callerDefinition = yaml.parse(caller);
      const preparationContract = yaml.parse(preparation);
      expect(callerDefinition.jobs.prepare.with).toStrictEqual({
        source_sha: '${{ needs.validate-request.outputs.source_sha }}',
        version: '${{ needs.validate-request.outputs.version }}',
        target_identity: '${{ needs.validate-request.outputs.target_identity }}',
        language_profile: '${{ needs.validate-request.outputs.language_profile }}',
        toolchain: '${{ needs.validate-request.outputs.toolchain }}',
        runner: '<versioned-runner>',
      });
      expect(callerDefinition.jobs.publish.with).toStrictEqual({
        runner: '<versioned-runner>', 'gh-version': '<gh-version>', 'jq-version': '<jq-version>',
        package_handoff_run_id: '${{ needs.prepare.outputs.handoff_run_id }}',
        source_sha: '${{ needs.validate-request.outputs.source_sha }}',
        version: '${{ needs.prepare.outputs.publish_version }}',
        target_identity: '${{ needs.validate-request.outputs.target_identity }}',
        package_artifact_id: '${{ needs.prepare.outputs.artifact_id }}',
      });
      expect(request).toMatch(/workflow_dispatch:/);
      includesAll(jobBlock(request, 'request'), [/permissions: \{\}/, /operation: create/]);
      includesAll(jobBlock(request, 'request'), [/if: always\(\)/, /ci-quality-summary@/]);
      expect(caller).toMatch(/workflow_run:/);
      includesAll(jobBlock(caller, 'validate-request'), [/actions: read/, /operation: verify/]);
      expect(Object.keys(preparationContract.on.workflow_call.outputs).sort()).toStrictEqual(['artifact_id', 'handoff_run_id', 'publish_version']);
      expect(preparationContract.concurrency).toBe(undefined);
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
            env: { ...process.env, PUBLISH_VERSION: version, PUBLISH_VERSION_JSON: JSON.stringify(version) }, timeout: spawnTimeoutMs,
          });
          // Assert
          expect(result.status, result.stderr).toBe(0);
          const plan = JSON.parse(readFileSync(path.join(directory, 'version-plan.json'), 'utf8'));
          expect(plan).toStrictEqual({ strategy: 'exact', publishVersion: version });
          expect(materializePublishVersion(plan)).toBe(version);
        }
      } finally { rmSync(directory, { recursive: true, force: true }); }

      expect(jobBlock(preparation, 'build')).toMatch(/needs: version-plan/);
      expect(publication).not.toMatch(/expected_caller=/);
    });
  });
});


describe("workflow-contracts", () => {
  describe("repository-quality-delivery-regression", () => {
    beforeEach(() => {
      // The fixture and the in-process verifier both invoke Git against scoped repositories.
      for (const name of Object.keys(process.env).filter((key) => key.startsWith('GIT_'))) {
        vi.stubEnv(name, undefined);
      }
    });
    afterEach(() => vi.unstubAllEnvs());

    // evidence_role: supplemental
    // flow_id: repository-action-reference-gate
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
      const command = (...args) => spawnSync(process.execPath, [path.join(root, 'runtime/repository/check-provider-references.mjs'), '--contracts', ...args], { cwd: fixture, encoding: 'utf8', timeout: slowSpawnTimeoutMs });
      // Act
      const strict = command();
      const preparation = command('--preparation');
      // Assert
      expect(strict.status, strict.stderr).toBe(1);
      expect(preparation.status, preparation.stderr).toBe(1);
      const rejected = JSON.parse(preparation.stdout);
      expect(rejected.preparationOnly).toBe(false);
      const contractFailures = rejected.connection.diagnostics.filter((diagnostic) => diagnostic.includes(': referenced Action contract failed: '));
      expect(contractFailures.map((diagnostic) => diagnostic.split(': referenced Action contract failed: ')[1])).toEqual(['quality-reserved', 'publication-owner-decision']);
      expect(rejected.connection.diagnostics).toEqual([...contractFailures, ...rejected.interfaceDiagnostics]);
      for (const field of ['skills-source-root', 'runner-policy', 'version-policy', 'resolved-toolchain-version']) {
        expect(rejected.interfaceDiagnostics).toContainEqual(expect.stringContaining(field));
      }
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

    // flow_id: repository-action-reference-contracts
    test.each(['const = ;', "require('a3-reference-test-missing-module');"])('preparation gate rejects an unexecutable fixed bundle: %s', (bundle) => {
      // Arrange
      const fixture = referenceFixture({ onTestFinished });
      const git = (...args) => execFileSync('git', args, { cwd: fixture, encoding: 'utf8', stdio: 'pipe', timeout: spawnTimeoutMs }).trim();
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
      const result = spawnSync(process.execPath, [path.join(root, 'runtime/repository/check-provider-references.mjs'), '--contracts', '--preparation'], { cwd: fixture, encoding: 'utf8', timeout: mediumSpawnTimeoutMs });
      // Assert
      expect(result.status, result.stdout).toBe(2);
      expect(result.stderr).toContain('action-contract-execution-unavailable');
    });

    // flow_id: repository-action-reference-contracts
    test('candidate gate reports uncommitted execution assets as an actionable reason', (t) => {
      // Arrange
      const fixture = referenceFixture(t);
      // Act
      const result = spawnSync(process.execPath, [path.join(root, 'runtime/repository/check-provider-references.mjs'), '--candidate', '--contracts'], { cwd: fixture, encoding: 'utf8', timeout: spawnTimeoutMs });
      const evidence = JSON.parse(result.stderr.split('\n').find((line) => line.startsWith('ci-failure-diagnostic:'))?.slice('ci-failure-diagnostic:'.length) ?? '{}');
      // Assert
      expect(result.status, result.stderr).toBe(2);
      expect(evidence.classification?.reason).toBe('implementation-candidate-execution-assets-dirty');
      expect(evidence.comparison).toMatchObject({ field: 'execution-assets', observed: 'uncommitted-changes' });
    });

    // flow_id: repository-action-reference-contracts
    test('candidate gate rejects a release tag that is already published', (t) => {
      // Arrange
      mkdirSync(path.join(root, 'tmp'), { recursive: true });
      const fixture = mkdtempSync(path.join(root, 'tmp/published-tag-candidate-'));
      t.onTestFinished(() => rmSync(fixture, { recursive: true, force: true }));
      execFileSync('git', ['clone', '--shared', '--quiet', root, fixture], { stdio: 'pipe', timeout: spawnTimeoutMs });
      const releaseTag = repositorySnapshot(fixture).registry.actionization.implementationSource.releaseTag;
      execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'tag', '-f', '-a', releaseTag, '-m', releaseTag, 'HEAD^'], { cwd: fixture, stdio: 'pipe', timeout: spawnTimeoutMs });
      // Act
      const result = spawnSync(process.execPath, [path.join(root, 'runtime/repository/check-provider-references.mjs'), '--staged', '--candidate', '--contracts'], { cwd: fixture, encoding: 'utf8', timeout: mediumSpawnTimeoutMs });
      const evidence = JSON.parse(result.stderr.split('\n').find((line) => line.startsWith('ci-failure-diagnostic:'))?.slice('ci-failure-diagnostic:'.length) ?? '{}');
      // Assert
      expect(result.status, result.stderr).toBe(2);
      expect(evidence.classification?.reason).toBe('implementation-candidate-release-tag-exists');
      expect(evidence.comparison).toMatchObject({ field: 'release-tag', observed: 'existing-tag' });
    });

    // flow_id: repository-quality-delivery-regression
    test('repository workflow provider actions use registry-approved pins', () => {
      const entries = yaml.parse(read('skills/ci-github/assets/registry/ci-github-preset-assets.yml')).providerActions.entries;
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
      const cacheSha = approved.get('actions/cache');
      expect(checkProviderReferences(workflow(`actions/cache/restore@${cacheSha}`), '.github/workflows/ci-quality.yml', approved)).toEqual([]);
      expect(checkProviderReferences(workflow(`actions/cache/save@${sha}`), '.github/workflows/ci-quality.yml', approved)).toHaveLength(1);
      expect(checkProviderReferences(workflow(`actions/unapproved/restore@${cacheSha}`), '.github/workflows/ci-quality.yml', approved)).toHaveLength(1);
      expect(checkProviderReferences('jobs: {call: {uses: owner/repo/.github/workflows/check.yml@main}}', '.github/workflows/ci-quality.yml', approved)).toHaveLength(1);
      expect(checkProviderReferences('runs: {using: composite, steps: [{uses: actions/checkout@main}]}', 'actions/example/action.yml', approved)).toHaveLength(1);
      expect(checkProviderReferences(workflow('./actions/example'), '.github/workflows/ci-quality.yml', approved)).toEqual([]);
      expect(() => checkProviderReferences('jobs: [', '.github/workflows/check.yml', approved)).toThrow();
      const releaseTag = repositorySnapshot(root).registry.actionization.implementationSource.releaseTag;
      const candidate = releaseTag === `v${read('VERSION').trim()}` && !execFileSync('git', ['tag', '--list', releaseTag], { cwd: root, encoding: 'utf8', timeout: spawnTimeoutMs }).trim();
      const checked = checkRepository(root, false, { candidate, preparation: !candidate });
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
          const expected = matrixJob ? '${{ matrix.runner }}' : '${{ inputs.runner }}';
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
        const commands = release ? ['provider-binding', testCommand] : ['provider-binding'];
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
          expect(step.run).not.toContain('|| true');
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
        for (const gateCommand of release ? ['provider-binding', 'npm test -- tests/workflow-contracts.test.mjs runtime/distribution/tests/selective-distribution.test.mjs runtime/repository/tests/single-release-binding.test.mjs'] : ['provider-binding']) {
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
            env: { ...process.env, A3_LINT_BIN: binary, LINT_CALLS: calls, LINT_REPORT: JSON.stringify(report), ...environment }, timeout: spawnTimeoutMs });
          expect(result.error).toBeUndefined();
          expect(result.status).not.toBe(0);
          expect(readFileSync(calls, 'utf8').trim().split('\n').length, JSON.stringify(environment) + readFileSync(calls, 'utf8')).toBeLessThanOrEqual(2);
          expect(result.stdout).not.toContain('a3-lint fixture groups passed');
          expect(readFileSync(calls, 'utf8')).not.toContain('--version');
        }
      } finally { rmSync(failureRoot, { recursive: true, force: true }); }
      const fixture = mkdtempSync(path.join(root, 'tmp/provider-reference-stage-'));
      const git = (...args) => execFileSync('git', args, { cwd: fixture, encoding: 'utf8', stdio: 'pipe', timeout: spawnTimeoutMs });
      try {
        git('init');
        const registryPath = 'skills/ci-github/assets/registry/ci-github-preset-assets.yml';
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
          { cwd: fixture, encoding: 'utf8', timeout: spawnTimeoutMs });
        // Act
        const rejectedReference = cli();
        // Assert
        expect(rejectedReference.status).toBe(1);
        expect(JSON.parse(rejectedReference.stdout).diagnostics).toHaveLength(1);
        expect(rejectedReference.stderr).toContain('repository-binding-rejected');
        // Arrange
        writeFileSync(path.join(fixture, '.github/workflows/ci-quality.yml'), workflow(`actions/checkout@${sha}`));
        const validRegistry = read(registryPath);
        const duplicate = yaml.parse(validRegistry);
        duplicate.providerActions.entries.push(duplicate.providerActions.entries[0]);
        const invalidPin = yaml.parse(validRegistry);
        invalidPin.providerActions.entries[0].commitSha = 'main';
        const registryCases = [
          ['YAML syntax', 'providerActions: [', /Invalid provider registry YAML/, /provider-registry-yaml-invalid/],
          ['duplicate action', yaml.stringify(duplicate), /Invalid provider pin registry/, /provider-pin-registry-invalid/],
          ['invalid SHA', yaml.stringify(invalidPin), /Invalid provider pin registry/, /provider-pin-registry-invalid/],
        ];
        for (const [label, content, diagnostic, publicReason] of registryCases) {
          writeFileSync(path.join(fixture, registryPath), content);
          // Act
          const result = cli();
          // Assert
          expect(() => checkRepository(fixture), label).toThrow(diagnostic);
          expect(result.status, label).toBe(2);
          expect(result.stdout, label).toBe('');
          expect(result.stderr, label).toMatch(publicReason);
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
        expect(missing.stderr).toContain('provider-callee-missing');
        expect(missing.stderr).toContain('ci-quality');
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
  });
});





describe('repository installer CI result gate', () => {
  describe('required hosted gate', () => {
    // evidence_role: supplemental
    // test_level: e2e
    // flow_id: repository-quality-delivery-regression
    test('requires installer Linux success and rejects failure cancellation and skipped execution', () => {
      // Arrange
      const step = yaml.parse(read('.github/workflows/quality-gate.yml')).jobs.contract.steps[0];
      const environment = { ...process.env, ...Object.fromEntries(Object.keys(step.env).map((key) => [key, 'success'])) };
      // Act
      const execute = (status) => spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step.run], {
        encoding: 'utf8', env: { ...environment, INSTALLER_LINUX_RESULT: status }, timeout: spawnTimeoutMs,
      });
      // Assert
      expect(execute('success').status).toBe(0);
      for (const status of ['failure', 'cancelled', 'skipped', '']) {
        const rejected = execute(status);
        expect(rejected.error, status).toBeUndefined();
        expect(rejected.status, status).not.toBe(0);
      }
    });
  });
});

describe("contract.ci-selective-distribution.publication", () => {
  describe("repository-selective-distribution-release", () => {
    // evidence_role: supplemental
    // The step order and the env bindings of the guard step are a workflow structure, not an observation of the dispatch guarantee.
    // contract_id: contract.ci-selective-distribution.release-dispatch
    test('repository release verifies the dispatch ref before checking out the tagged release', () => {
      const steps = yaml.parse(read('.github/workflows/release.yml')).jobs['prepare-distribution'].steps;
      const guardIndex = steps.findIndex((step) => step.name === 'Verify dispatch ref is the release tag');
      expect(guardIndex).toBeGreaterThanOrEqual(0);
      expect(guardIndex).toBeLessThan(steps.findIndex((entry) => entry.name === 'Checkout tagged release'));
      expect(steps[guardIndex].env).toEqual({ RELEASE_TAG: '${{ inputs.release-tag }}', DISPATCH_REF: '${{ github.ref }}' });
    });

    // contract_id: contract.ci-selective-distribution.release-dispatch
    // integration_id: repository-selective-distribution-release
    test('repository release accepts only a dispatch from the requested release tag', () => {
      // Arrange
      const steps = yaml.parse(read('.github/workflows/release.yml')).jobs['prepare-distribution'].steps;
      const guardIndex = steps.findIndex((step) => step.name === 'Verify dispatch ref is the release tag');
      const step = steps[guardIndex];
      const checkoutIndex = steps.findIndex((candidate) => candidate.uses?.startsWith('actions/checkout@'));
      expect(guardIndex).toBeGreaterThanOrEqual(0);
      expect(guardIndex).toBeLessThan(checkoutIndex);
      expect(step.env).toMatchObject({
        RELEASE_TAG: '${{ inputs.release-tag }}',
        DISPATCH_REF: '${{ github.ref }}',
      });
      expect(steps[checkoutIndex].with.ref).toBe(step.env.RELEASE_TAG);
      // Act
      const execute = (dispatchRef, releaseTag = 'v1.2.3') => spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step.run], {
        encoding: 'utf8', env: { ...process.env, RELEASE_TAG: releaseTag, DISPATCH_REF: dispatchRef,
          GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '452', GITHUB_JOB: 'prepare-distribution',
          GITHUB_SHA: 'a'.repeat(40) }, timeout: spawnTimeoutMs,
      });
      // Assert
      expect(execute('refs/tags/v1.2.3').status).toBe(0);
      for (const releaseTag of ['', 'v01.2.3', 'v1.2.3-rc.1']) {
        const rejected = execute(`refs/tags/${releaseTag}`, releaseTag);
        expect(rejected.status, releaseTag).toBe(1);
        const [, evidence] = rejected.stderr.match(/^ci-failure-diagnostic:(.+)$/m);
        expect(JSON.parse(evidence)).toMatchObject({
          classification: { stage: 'dispatch-ref-validation', reason: 'release-dispatch-tag-invalid' },
          comparison: { field: 'release-tag', expected: 'exact-semver-tag', observed: 'invalid' },
          'execution-state': { outcome: 'failure', exit: 1, lastConfirmed: 'not-started', write: 'not-started' },
        });
      }
      for (const dispatchRef of ['refs/heads/main', 'refs/heads/hotfix/1.2.3', 'refs/tags/v1.2.4', 'v1.2.3', '']) {
        const rejected = execute(dispatchRef);
        expect(rejected.error, dispatchRef).toBeUndefined();
        expect(rejected.status, dispatchRef).not.toBe(0);
        expect(rejected.stderr, dispatchRef).toContain('refs/tags/v1.2.3');
        const diagnostic = rejected.stderr.match(/^ci-failure-diagnostic:(.+)$/m);
        expect(diagnostic, rejected.stderr).not.toBeNull();
        expect(JSON.parse(diagnostic[1])).toMatchObject({
          classification: { subject: 'ci-selective-distribution', operation: 'release-dispatch',
            stage: 'dispatch-ref-validation', reason: 'release-dispatch-ref-mismatch' },
          context: { run: '452', job: 'prepare-distribution', source: 'unavailable' },
          'evidence-location': { log: 'workflow-run-job-step-log', artifact: 'not-generated' },
          comparison: { field: 'dispatch-ref', expected: 'requested-release-tag-ref', observed: 'mismatch' },
          'execution-state': { outcome: 'failure', exit: rejected.status, lastConfirmed: 'tag-format-validation', write: 'not-started' },
          'next-check': { rule: 'release-dispatch-ref-mismatch', input: 'release-tag-and-dispatch-ref' },
        });
      }
    });
  });
});
