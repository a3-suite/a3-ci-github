import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { test, describe, expect } from 'vitest';
import { fileURLToPath } from 'node:url';

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(scriptRoot, '../..');
const hasPwsh = spawnSync('pwsh', ['--version'], { encoding: 'utf8' }).status === 0;
const nativePowerShells = process.platform === 'win32' ? ['powershell', 'pwsh'].filter((shell) => spawnSync(shell, ['-NoProfile', '-Command', 'exit 0']).status === 0) : [];

const withFixture = (callback) => {
  const temporaryRoot = path.join(repositoryRoot, 'tests/tmp');
  mkdirSync(temporaryRoot, { recursive: true });
  const fixture = mkdtempSync(path.join(temporaryRoot, 'a3-ci-github-rust-release-'));
  try {
    callback(fixture);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    expect(existsSync(fixture)).toBe(false);
  }
};

const run = (command, args, options = {}) => spawnSync(command, args, {
  cwd: repositoryRoot,
  encoding: 'utf8',
  ...options,
});

const sha256 = (content) => createHash('sha256').update(content.replaceAll('\r\n', '\n')).digest('hex');

const failureEvidence = (stderr) => {
  const prefix = 'ci-failure-diagnostic:';
  const line = stderr.split(/\r?\n/).findLast((entry) => entry.startsWith(prefix));
  expect(line, stderr).toBeDefined();
  return JSON.parse(line.slice(prefix.length));
};

const initializeGitFixture = (fixture) => {
  writeFileSync(path.join(fixture, 'source.txt'), 'fixture source\n');
  execFileSync('git', ['init', '--quiet'], { cwd: fixture });
  execFileSync('git', ['add', 'source.txt'], { cwd: fixture });
  execFileSync('git', [
    '-c', 'user.name=CI Fixture',
    '-c', 'user.email=ci-fixture@example.invalid',
    'commit', '--quiet', '-m', 'Initialize fixture',
  ], { cwd: fixture });
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: fixture,
    encoding: 'utf8',
  }).trim();
};

export { scriptRoot, repositoryRoot, hasPwsh, nativePowerShells, withFixture, run, sha256, failureEvidence, initializeGitFixture };
