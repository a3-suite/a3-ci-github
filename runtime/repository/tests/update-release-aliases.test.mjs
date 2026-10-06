import { afterAll as after, test, describe, expect } from 'vitest';
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
  expect(existsSync(temporaryRoot)).toBe(false);
  if (!sharedTemporaryRootExisted) {
    try {
      rmdirSync(sharedTemporaryRoot);
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY') throw error;
    }
  }
});

const execute = (command, args, options = {}) => spawnSync(command, args, {
  cwd: options.cwd,
  env: options.env,
  encoding: 'utf8',
});
const successful = (command, args, options = {}) => {
  const result = execute(command, args, options);
  expect(result.status, `${command} ${args.join(' ')}\n${result.stderr || result.stdout}`).toBe(0);
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

describe("update-release-aliases", () => {
  test('repository VERSION is a release or development SemVer', () => {
    const version = readFileSync(path.join(repositoryRoot, 'VERSION'), 'utf8').trim();
    expect(version).toMatch(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-dev\.(0|[1-9][0-9]*))?$/);
  });
});

describe("repository-release-alias-update", () => {
  // integration_id: repository-release-alias-update
  test('release workflow delegates alias mutation to the executable repository runtime', () => {
    const workflow = readFileSync(path.join(repositoryRoot, '.github/workflows/release.yml'), 'utf8');
    const marker = '      - name: Update major and minor aliases\n';
    const start = workflow.indexOf(marker);
    expect(start).not.toBe(-1);
    const nextJob = workflow.indexOf('\n\n  ', start);
    const updateStep = workflow.slice(start, nextJob === -1 ? undefined : nextJob);
    expect(updateStep).toMatch(/^          RELEASE_TAG: \$\{\{ inputs\.release-tag \}\}$/m);
    expect(updateStep).toMatch(/^          RELEASE_SHA: \$\{\{ needs\.prepare-distribution\.outputs\.source_sha \}\}$/m);
    expect(updateStep).toMatch(/^        shell: bash$/m);
    expect(updateStep).toMatch(/^        run: runtime\/repository\/update-release-aliases\.sh$/m);
    expect(updateStep).not.toMatch(/^        run: \|/m);
    expect(statSync(scriptPath).mode & 0o111).not.toBe(0);
  });

  // integration_id: repository-release-alias-update
  test('release source validation performs no alias mutation', () => {
    const { work } = createRepository();
    const sourceSha = git(work, 'rev-parse', 'HEAD');
    pushReleaseTag(work, 'v1.2.3', sourceSha);

    const validated = updateAliasesAt(work, 'v1.2.3', sourceSha, { CI_RELEASE_VALIDATE_ONLY: 'true' });
    expect(validated.status, validated.stderr).toBe(0);
    expect(validated.stdout).toMatch(/Validated release source/);
    expect(remoteTagObject(work, 'v1')).toBe('');
    expect(remoteTagObject(work, 'v1.2')).toBe('');
  });

  // integration_id: repository-release-alias-update
  test('canonical next-patch hotfix can publish before main integration and rejects stale branch or base', () => {
    const { work } = createRepository('1.2.2');
    const baseSha = git(work, 'rev-parse', 'HEAD');
    pushReleaseTag(work, 'v1.2.2', baseSha);
    git(work, 'checkout', '-b', 'hotfix/1.2.3');
    const sourceSha = appendCommit(work, 'hotfix', '1.2.3');
    git(work, 'push', 'origin', 'hotfix/1.2.3');
    pushReleaseTag(work, 'v1.2.3', sourceSha);
    const validated = updateAliasesAt(work, 'v1.2.3', sourceSha, { CI_RELEASE_VALIDATE_ONLY: 'true' });
    expect(validated.status, validated.stderr).toBe(0);
    expect(remoteTagObject(work, 'v1')).toBe('');
    expect(updateAliases(work, 'v1.2.3', sourceSha).status).toBe(0);
    expect(remoteTagSource(work, 'v1.2')).toBe(sourceSha);
    appendCommit(work, 'later hotfix');
    git(work, 'push', 'origin', 'hotfix/1.2.3');
    const staleTip = updateAliasesAt(work, 'v1.2.3', sourceSha, { CI_RELEASE_VALIDATE_ONLY: 'true' });
    expect(staleTip.status).toBe(1);
    expect(staleTip.stderr).toMatch(/canonical hotfix tip/);
    git(work, 'push', 'origin', `${sourceSha}:refs/heads/hotfix/1.2.3`, '--force-with-lease');
    git(work, 'checkout', 'main');
    appendCommit(work, 'next stable', '1.3.0');
    git(work, 'push', 'origin', 'main');
    const staleBase = updateAliasesAt(work, 'v1.2.3', sourceSha, { CI_RELEASE_VALIDATE_ONLY: 'true' });
    expect(staleBase.status).toBe(1);
    expect(staleBase.stderr).toMatch(/current stable main version/);
  });

  // integration_id: repository-release-alias-update
  test.each(['lightweight base', 'unrelated source'])('canonical hotfix rejects %s', (invalidCase) => {
    const { work } = createRepository('1.2.2');
    const baseSha = git(work, 'rev-parse', 'HEAD');
    pushReleaseTag(work, 'v1.2.2', baseSha, invalidCase !== 'lightweight base');
    git(work, 'checkout', invalidCase === 'unrelated source' ? '--orphan' : '-b', 'hotfix/1.2.3');
    const sourceSha = appendCommit(work, 'hotfix', '1.2.3');
    git(work, 'push', 'origin', 'hotfix/1.2.3');
    pushReleaseTag(work, 'v1.2.3', sourceSha);
    const result = updateAliasesAt(work, 'v1.2.3', sourceSha, { CI_RELEASE_VALIDATE_ONLY: 'true' });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(invalidCase === 'lightweight base' ? /base tag must be annotated/ : /does not descend from its base/);
    expect(remoteTagObject(work, 'v1')).toBe('');
  });

  // integration_id: repository-release-alias-update
  test('release tags reject development VERSION even when integrated into main', () => {
    const { work } = createRepository('1.2.3-dev.0');
    const sourceSha = git(work, 'rev-parse', 'HEAD');
    pushReleaseTag(work, 'v1.2.3', sourceSha);
    const result = updateAliases(work, 'v1.2.3', sourceSha);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/VERSION must be a release SemVer/);
    expect(remoteTagObject(work, 'v1')).toBe('');
  });

  // integration_id: repository-release-alias-update
  test('release alias updater creates annotated major and minor aliases idempotently', () => {
    const { work } = createRepository();
    const sourceSha = git(work, 'rev-parse', 'HEAD');
    pushReleaseTag(work, 'v1.2.3', sourceSha);

    const first = updateAliases(work, 'v1.2.3', sourceSha);
    expect(first.status, first.stderr).toBe(0);
    for (const alias of ['v1', 'v1.2']) {
      expect(remoteTagObject(work, alias)).not.toBe(sourceSha);
      expect(remoteTagSource(work, alias)).toBe(sourceSha);
    }

    const second = updateAliases(work, 'v1.2.3', sourceSha);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toMatch(/already points|already at least as new/);
  });

  // integration_id: repository-release-alias-update
  test('release alias updater never regresses an alias to an older release', () => {
    const { work } = createRepository();
    const firstSha = git(work, 'rev-parse', 'HEAD');
    pushReleaseTag(work, 'v1.2.3', firstSha);
    expect(updateAliases(work, 'v1.2.3', firstSha).status).toBe(0);

    const newerSha = appendCommit(work, 'newer', '1.3.0');
    git(work, 'push', 'origin', 'main');
    pushReleaseTag(work, 'v1.3.0', newerSha);
    expect(updateAliases(work, 'v1.3.0', newerSha).status).toBe(0);
    expect(remoteTagSource(work, 'v1')).toBe(newerSha);

    const older = updateAliases(work, 'v1.2.3', firstSha);
    expect(older.status, older.stderr).toBe(0);
    expect(remoteTagSource(work, 'v1')).toBe(newerSha);
    expect(remoteTagSource(work, 'v1.2')).toBe(firstSha);
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
    expect(missingResult.status).toBe(1);
    expect(missingResult.stderr).toMatch(/must contain VERSION/);
    expect(remoteTagObject(missing.work, 'v1')).toBe('');

    const invalid = createRepository('01.2.3');
    const invalidSha = git(invalid.work, 'rev-parse', 'HEAD');
    pushReleaseTag(invalid.work, 'v1.2.3', invalidSha);
    const invalidResult = updateAliases(invalid.work, 'v1.2.3', invalidSha);
    expect(invalidResult.status).toBe(1);
    expect(invalidResult.stderr).toMatch(/VERSION must be a release SemVer/);
    expect(remoteTagObject(invalid.work, 'v1')).toBe('');
  });

  // integration_id: repository-release-alias-update
  test('release alias updater rejects a tag that differs from repository VERSION', () => {
    const { work } = createRepository('1.2.4');
    const sourceSha = git(work, 'rev-parse', 'HEAD');
    pushReleaseTag(work, 'v1.2.3', sourceSha);

    const mismatch = updateAliases(work, 'v1.2.3', sourceSha);
    expect(mismatch.status).toBe(1);
    expect(mismatch.stderr).toMatch(/does not match repository VERSION/);
    expect(remoteTagObject(work, 'v1')).toBe('');
    expect(remoteTagObject(work, 'v1.2')).toBe('');
  });

  // integration_id: repository-release-alias-update
  test('release alias updater rejects invalid identity and bare repositories before remote mutation', () => {
    const { origin, work } = createRepository();
    const sourceSha = git(work, 'rev-parse', 'HEAD');
    pushReleaseTag(work, 'v1.2.3', sourceSha);

    const invalidTag = updateAliases(work, 'release-1.2.3', sourceSha);
    expect(invalidTag.status).toBe(1);
    expect(invalidTag.stderr).toMatch(/release tag must match vX\.Y\.Z/);

    const mismatchedSha = updateAliases(work, 'v1.2.3', '0'.repeat(40));
    expect(mismatchedSha.status).toBe(1);
    expect(mismatchedSha.stderr).toMatch(/tag source does not match/);

    const bareRepository = updateAliasesAt(origin, 'v1.2.3', sourceSha);
    expect(bareRepository.status).toBe(1);
    expect(bareRepository.stderr).toMatch(/requires a Git work tree/);
    expect(remoteTagObject(work, 'v1')).toBe('');
    expect(remoteTagObject(work, 'v1.2')).toBe('');
  });

  // integration_id: repository-release-alias-update
  test('release alias updater rejects lightweight and unintegrated release tags', () => {
    const lightweight = createRepository();
    const mainSha = git(lightweight.work, 'rev-parse', 'HEAD');
    pushReleaseTag(lightweight.work, 'v1.2.3', mainSha, false);
    const lightweightResult = updateAliases(lightweight.work, 'v1.2.3', mainSha);
    expect(lightweightResult.status).toBe(1);
    expect(lightweightResult.stderr).toMatch(/release tag must be annotated/);

    const unintegrated = createRepository();
    git(unintegrated.work, 'checkout', '-b', 'release-candidate');
    const candidateSha = appendCommit(unintegrated.work, 'candidate', '2.0.0');
    pushReleaseTag(unintegrated.work, 'v2.0.0', candidateSha);
    const unintegratedResult = updateAliases(unintegrated.work, 'v2.0.0', candidateSha);
    expect(unintegratedResult.status).toBe(1);
    expect(unintegratedResult.stderr).toMatch(/not integrated into main/);
    expect(remoteTagObject(unintegrated.work, 'v2')).toBe('');
    expect(remoteTagObject(unintegrated.work, 'v2.0')).toBe('');
  });
});
