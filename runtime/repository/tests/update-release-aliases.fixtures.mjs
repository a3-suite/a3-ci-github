import { afterAll as after, test, describe, expect } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Synchronous child processes block the worker, so Vitest's testTimeout cannot interrupt them; bound each call.
// Measured max 2.1s per call; the limit is about 5x that. A timeout means the call regressed:
// investigate its performance or split it before raising the limit.
const spawnTimeoutMs = 11000;

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
  timeout: spawnTimeoutMs,
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
const createSquashIntegratedHotfix = () => {
  const { work } = createRepository('1.2.2');
  pushReleaseTag(work, 'v1.2.2', git(work, 'rev-parse', 'HEAD'));
  git(work, 'checkout', '-b', 'hotfix/1.2.3');
  appendCommit(work, 'development', '1.2.3-dev.0');
  const sourceSha = appendCommit(work, 'release', '1.2.3');
  git(work, 'push', 'origin', 'hotfix/1.2.3');
  pushReleaseTag(work, 'v1.2.3', sourceSha);
  const publication = updateAliases(work, 'v1.2.3', sourceSha);
  expect(publication.status, publication.stderr).toBe(0);
  git(work, 'checkout', 'main');
  git(work, 'merge', '--squash', 'hotfix/1.2.3');
  git(work, 'commit', '-m', 'integrate published release');
  git(work, 'push', 'origin', 'main');
  return { work, sourceSha, mainSha: git(work, 'rev-parse', 'HEAD') };
};

export { spawnTimeoutMs, testRoot, repositoryRoot, scriptPath, sharedTemporaryRoot, sharedTemporaryRootExisted, temporaryRoot, execute, successful, git, createRepository, appendCommit, pushReleaseTag, updateAliasesAt, updateAliases, remoteTagObject, remoteTagSource, createSquashIntegratedHotfix };
