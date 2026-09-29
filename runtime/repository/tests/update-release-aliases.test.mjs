import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testRoot, '../../..');
const scriptPath = path.resolve(testRoot, '../update-release-aliases.sh');
const sharedTemporaryRoot = path.join(testRoot, 'tmp');
const sharedTemporaryRootExisted = existsSync(sharedTemporaryRoot);
const temporaryRoot = path.join(sharedTemporaryRoot, `release-alias-${process.pid}-${Date.now()}`);
mkdirSync(temporaryRoot, { recursive: true });
after(() => {
  rmSync(temporaryRoot, { recursive: true, force: true });
  assert.equal(existsSync(temporaryRoot), false);
  if (!sharedTemporaryRootExisted) rmdirSync(sharedTemporaryRoot);
});

const execute = (command, args, options = {}) => spawnSync(command, args, {
  cwd: options.cwd,
  env: options.env,
  encoding: 'utf8',
});
const successful = (command, args, options = {}) => {
  const result = execute(command, args, options);
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stderr || result.stdout}`);
  return result.stdout.trim();
};
const git = (cwd, ...args) => successful('git', args, { cwd });
const createRepository = (version = '1.2.3') => {
  const fixture = mkdtempSync(path.join(temporaryRoot, 'fixture-'));
  const origin = path.join(fixture, 'origin.git');
  const work = path.join(fixture, 'work');
  git(fixture, 'init', '--bare', origin);
  git(fixture, 'init', work);
  git(work, 'config', 'user.name', 'Release Test');
  git(work, 'config', 'user.email', 'release-test@example.invalid');
  writeFileSync(path.join(work, 'artifact.txt'), 'initial\n');
  writeFileSync(path.join(work, 'VERSION'), `${version}\n`);
  git(work, 'add', 'artifact.txt', 'VERSION');
  git(work, 'commit', '-m', 'initial');
  git(work, 'branch', '-M', 'main');
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '-u', 'origin', 'main');
  return { origin, work };
};
const appendCommit = (work, value, version) => {
  writeFileSync(path.join(work, 'artifact.txt'), `${readFileSync(path.join(work, 'artifact.txt'), 'utf8')}${value}\n`);
  if (version) writeFileSync(path.join(work, 'VERSION'), `${version}\n`);
  git(work, 'add', 'artifact.txt', 'VERSION');
  git(work, 'commit', '-m', value);
  return git(work, 'rev-parse', 'HEAD');
};
const pushReleaseTag = (work, tag, sha, annotated = true) => {
  if (annotated) git(work, 'tag', '-a', tag, sha, '-m', tag);
  else git(work, 'tag', tag, sha);
  git(work, 'push', 'origin', `refs/tags/${tag}`);
};
const updateAliasesAt = (cwd, tag, sha, extraEnv = {}) => execute(scriptPath, [], {
  cwd,
  env: { ...process.env, RELEASE_TAG: tag, RELEASE_SHA: sha, ...extraEnv },
});
const updateAliases = (work, tag, sha) => updateAliasesAt(work, tag, sha);
const remoteTagObject = (work, tag) => git(work, 'ls-remote', '--refs', 'origin', `refs/tags/${tag}`).split(/\s+/)[0] ?? '';
const remoteTagSource = (work, tag) => git(work, 'ls-remote', 'origin', `refs/tags/${tag}^{}`).split(/\s+/)[0] ?? '';

test('repository VERSION is a release SemVer', () => {
  const version = readFileSync(path.join(repositoryRoot, 'VERSION'), 'utf8').trim();
  assert.match(version, /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/);
});

// integration_id: repository-release-alias-update
test('release workflow delegates alias mutation to the executable repository runtime', () => {
  const workflow = readFileSync(path.join(repositoryRoot, '.github/workflows/release.yml'), 'utf8');
  const marker = '      - name: Update major and minor aliases\n';
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1);
  const nextJob = workflow.indexOf('\n\n  ', start);
  const updateStep = workflow.slice(start, nextJob === -1 ? undefined : nextJob);
  assert.match(updateStep, /^          RELEASE_TAG: \$\{\{ github\.ref_name \}\}$/m);
  assert.match(updateStep, /^          RELEASE_SHA: \$\{\{ github\.sha \}\}$/m);
  assert.match(updateStep, /^        shell: bash$/m);
  assert.match(updateStep, /^        run: runtime\/repository\/update-release-aliases\.sh$/m);
  assert.doesNotMatch(updateStep, /^        run: \|/m);
  assert.notEqual(statSync(scriptPath).mode & 0o111, 0);
});

// integration_id: repository-release-alias-update
test('release source validation performs no alias mutation', () => {
  const { work } = createRepository();
  const sourceSha = git(work, 'rev-parse', 'HEAD');
  pushReleaseTag(work, 'v1.2.3', sourceSha);

  const validated = updateAliasesAt(work, 'v1.2.3', sourceSha, { CI_RELEASE_VALIDATE_ONLY: 'true' });
  assert.equal(validated.status, 0, validated.stderr);
  assert.match(validated.stdout, /Validated release source/);
  assert.equal(remoteTagObject(work, 'v1'), '');
  assert.equal(remoteTagObject(work, 'v1.2'), '');
});

// integration_id: repository-release-alias-update
test('release alias updater creates annotated major and minor aliases idempotently', () => {
  const { work } = createRepository();
  const sourceSha = git(work, 'rev-parse', 'HEAD');
  pushReleaseTag(work, 'v1.2.3', sourceSha);

  const first = updateAliases(work, 'v1.2.3', sourceSha);
  assert.equal(first.status, 0, first.stderr);
  for (const alias of ['v1', 'v1.2']) {
    assert.notEqual(remoteTagObject(work, alias), sourceSha);
    assert.equal(remoteTagSource(work, alias), sourceSha);
  }

  const second = updateAliases(work, 'v1.2.3', sourceSha);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /already points|already at least as new/);
});

// integration_id: repository-release-alias-update
test('release alias updater never regresses an alias to an older release', () => {
  const { work } = createRepository();
  const firstSha = git(work, 'rev-parse', 'HEAD');
  pushReleaseTag(work, 'v1.2.3', firstSha);
  assert.equal(updateAliases(work, 'v1.2.3', firstSha).status, 0);

  const newerSha = appendCommit(work, 'newer', '1.3.0');
  git(work, 'push', 'origin', 'main');
  pushReleaseTag(work, 'v1.3.0', newerSha);
  assert.equal(updateAliases(work, 'v1.3.0', newerSha).status, 0);
  assert.equal(remoteTagSource(work, 'v1'), newerSha);

  const older = updateAliases(work, 'v1.2.3', firstSha);
  assert.equal(older.status, 0, older.stderr);
  assert.equal(remoteTagSource(work, 'v1'), newerSha);
  assert.equal(remoteTagSource(work, 'v1.2'), firstSha);
});

// integration_id: repository-release-alias-update
test('release alias updater rejects missing and invalid repository VERSION', () => {
  const missing = createRepository();
  rmSync(path.join(missing.work, 'VERSION'));
  git(missing.work, 'add', '-A', 'VERSION');
  git(missing.work, 'commit', '-m', 'remove version');
  const missingSha = git(missing.work, 'rev-parse', 'HEAD');
  git(missing.work, 'push', 'origin', 'main');
  pushReleaseTag(missing.work, 'v1.2.3', missingSha);
  const missingResult = updateAliases(missing.work, 'v1.2.3', missingSha);
  assert.equal(missingResult.status, 1);
  assert.match(missingResult.stderr, /must contain VERSION/);
  assert.equal(remoteTagObject(missing.work, 'v1'), '');

  const invalid = createRepository('01.2.3');
  const invalidSha = git(invalid.work, 'rev-parse', 'HEAD');
  pushReleaseTag(invalid.work, 'v1.2.3', invalidSha);
  const invalidResult = updateAliases(invalid.work, 'v1.2.3', invalidSha);
  assert.equal(invalidResult.status, 1);
  assert.match(invalidResult.stderr, /VERSION must be a release SemVer/);
  assert.equal(remoteTagObject(invalid.work, 'v1'), '');
});

// integration_id: repository-release-alias-update
test('release alias updater rejects a tag that differs from repository VERSION', () => {
  const { work } = createRepository('1.2.4');
  const sourceSha = git(work, 'rev-parse', 'HEAD');
  pushReleaseTag(work, 'v1.2.3', sourceSha);

  const mismatch = updateAliases(work, 'v1.2.3', sourceSha);
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /does not match repository VERSION/);
  assert.equal(remoteTagObject(work, 'v1'), '');
  assert.equal(remoteTagObject(work, 'v1.2'), '');
});

// integration_id: repository-release-alias-update
test('release alias updater rejects invalid identity and bare repositories before remote mutation', () => {
  const { origin, work } = createRepository();
  const sourceSha = git(work, 'rev-parse', 'HEAD');
  pushReleaseTag(work, 'v1.2.3', sourceSha);

  const invalidTag = updateAliases(work, 'release-1.2.3', sourceSha);
  assert.equal(invalidTag.status, 1);
  assert.match(invalidTag.stderr, /release tag must match vX\.Y\.Z/);

  const mismatchedSha = updateAliases(work, 'v1.2.3', '0'.repeat(40));
  assert.equal(mismatchedSha.status, 1);
  assert.match(mismatchedSha.stderr, /tag source does not match/);

  const bareRepository = updateAliasesAt(origin, 'v1.2.3', sourceSha);
  assert.equal(bareRepository.status, 1);
  assert.match(bareRepository.stderr, /requires a Git work tree/);
  assert.equal(remoteTagObject(work, 'v1'), '');
  assert.equal(remoteTagObject(work, 'v1.2'), '');
});

// integration_id: repository-release-alias-update
test('release alias updater rejects lightweight and unintegrated release tags', () => {
  const lightweight = createRepository();
  const mainSha = git(lightweight.work, 'rev-parse', 'HEAD');
  pushReleaseTag(lightweight.work, 'v1.2.3', mainSha, false);
  const lightweightResult = updateAliases(lightweight.work, 'v1.2.3', mainSha);
  assert.equal(lightweightResult.status, 1);
  assert.match(lightweightResult.stderr, /release tag must be annotated/);

  const unintegrated = createRepository();
  git(unintegrated.work, 'checkout', '-b', 'release-candidate');
  const candidateSha = appendCommit(unintegrated.work, 'candidate', '2.0.0');
  pushReleaseTag(unintegrated.work, 'v2.0.0', candidateSha);
  const unintegratedResult = updateAliases(unintegrated.work, 'v2.0.0', candidateSha);
  assert.equal(unintegratedResult.status, 1);
  assert.match(unintegratedResult.stderr, /not integrated into main/);
  assert.equal(remoteTagObject(unintegrated.work, 'v2'), '');
  assert.equal(remoteTagObject(unintegrated.work, 'v2.0'), '');
});
