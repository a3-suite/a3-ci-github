import { existsSync, globSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import yaml from 'yaml';
import { checkActionReferences, checkProviderReferences, checkRepository, registryPath, repositorySnapshot } from '../runtime/repository/check-provider-references.mjs';
import { verifyActionReferenceContracts } from '../runtime/repository/verify-action-reference-contracts.mjs';
import { collectActionPackages, sharedRuntimeVerificationPlan, verificationPlan } from '../runtime/repository/verify-action-packages.mjs';
import vitestConfig from '../vitest.config.mjs';
import path from 'node:path';
import { test, describe, expect, onTestFinished } from 'vitest';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createDocsOnlyMatcher, detectChangeScope } from '../actions/ci-change-scope/src/scope.ts';
import { materializePublishVersion } from '../actions/ci-publish-version/src/materialize.ts';
import { resolveConfigSnapshot } from '../actions/ci-config-snapshot/src/snapshot.ts';
import { releaseSkillsFixture } from '../runtime/release-publication/tests/fixtures.mjs';
// Synchronous child processes block the worker, so Vitest's testTimeout cannot interrupt them; bound each call.
// Limits are about 5x the measured max of each call group (5s floor). A timeout means the call regressed:
// investigate its performance or split it before raising the limit.
const spawnTimeoutMs = 5000; // git and shell steps: measured max 0.17s
const mediumSpawnTimeoutMs = 11000; // provider reference checks in a cloned fixture: measured max 2.0s
const slowSpawnTimeoutMs = 35000; // provider reference check over the full contract set: measured max 6.4s

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');
const actionRef = yaml.parse(read('skills/ci-github/assets/registry/ci-github-preset-assets.yml')).actionization.implementationSource.exactRef;
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
  const run = (env) => spawnSync('bash', ['-c', entry.run], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env }, timeout: spawnTimeoutMs });
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


const referenceFixture = (t) => {
      mkdirSync(path.join(root, 'tmp'), { recursive: true });
      const fixture = mkdtempSync(path.join(root, 'tmp/action-reference-gate-'));
      t.onTestFinished(() => rmSync(fixture, { recursive: true, force: true }));
      execFileSync('git', ['clone', '--shared', '--no-checkout', root, fixture], { stdio: 'pipe', timeout: spawnTimeoutMs });
      const releaseTag = repositorySnapshot(root).registry.actionization.implementationSource.releaseTag;
      if (spawnSync('git', ['merge-base', '--is-ancestor', actionRef, `${releaseTag}^{commit}`], { cwd: fixture, timeout: spawnTimeoutMs }).status !== 0) {
        execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'tag', '-f', '-a', releaseTag, '-m', releaseTag, 'HEAD'], { cwd: fixture, stdio: 'pipe', timeout: spawnTimeoutMs });
      }
      mkdirSync(path.join(fixture, 'actions'));
      for (const relative of [registryPath, ...repositorySnapshot(root).targets]) {
        mkdirSync(path.dirname(path.join(fixture, relative)), { recursive: true });
        writeFileSync(path.join(fixture, relative), read(relative));
      }
      return fixture;
    };

const pinOldActionReferences = (fixture) => {
      const old = execFileSync('git', ['rev-parse', 'refs/tags/v0.2.0^{commit}'], { cwd: fixture, encoding: 'utf8', timeout: spawnTimeoutMs }).trim();
      for (const relative of [registryPath, ...repositorySnapshot(fixture).targets]) {
        writeFileSync(path.join(fixture, relative), readFileSync(path.join(fixture, relative), 'utf8').replaceAll(actionRef, old));
      }
      const registry = yaml.parse(readFileSync(path.join(fixture, registryPath), 'utf8'));
      registry.actionization.implementationSource.releaseTag = 'v0.2.0';
      writeFileSync(path.join(fixture, registryPath), yaml.stringify(registry));
    };
export { spawnTimeoutMs, mediumSpawnTimeoutMs, slowSpawnTimeoutMs, root, read, actionRef, includesAll, jobBlock, stepsOf, stepContaining, stepIndexContaining, stepBlock, summaryNeeds, assertNeeds, unitRecord, assertPublicationControl, referenceFixture, pinOldActionReferences };
