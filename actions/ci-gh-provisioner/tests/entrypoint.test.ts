// flow_id: ci-gh-provisioner-entrypoint
// test_level: e2e
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, test, expect } from 'vitest';

import { actionEntrypointArguments } from '../../../tests/support/action-entrypoint';
import { provisionerWorkspace, readGithubPath, runProvisionerEntrypoint } from '../../../tests/support/provisioner-entrypoint';

const version = '2.80.0';
const releaseUrl = `https://github.com/cli/cli/releases/download/v${version}`;
const checksumUrl = `${releaseUrl}/gh_${version}_checksums.txt`;
const assetName = (platform: string): string => `gh_${version}_${platform}.tar.gz`;
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function workspace(): { root: string; runnerTemp: string; githubPath: string } {
  const root = provisionerWorkspace(path.resolve(__dirname, 'tmp'), 'ci-gh-entrypoint-');
  roots.push(root);
  const runnerTemp = path.join(root, 'runner-temp');
  mkdirSync(runnerTemp);
  return { root, runnerTemp, githubPath: path.join(root, 'github-path') };
}

function archive(root: string, platform: string): Buffer {
  const member = `gh_${version}_${platform}/bin/gh`;
  const staging = path.join(root, 'staging');
  mkdirSync(path.join(staging, path.dirname(member)), { recursive: true });
  writeFileSync(path.join(staging, member), 'gh fixture');
  const archivePath = path.join(root, 'fixture.tar.gz');
  execFileSync('tar', ['-czf', archivePath, '-C', staging, member.split('/')[0]!]);
  return readFileSync(archivePath);
}

const manifest = (digest: string, asset: string): Buffer => Buffer.from(`${digest}  ${asset}\n`);
const sha256 = (value: Buffer): string => createHash('sha256').update(value).digest('hex');
const failureDiagnostic = (stderr: string): unknown => {
  const line = stderr.split('\n').find((value) => value.startsWith('ci-failure-diagnostic:'));
  return JSON.parse(line?.slice('ci-failure-diagnostic:'.length) ?? '{}');
};
const provisionedDirectories = (runnerTemp: string): string[] => readdirSync(runnerTemp).filter((entry) => entry.startsWith('ci-gh-'));

describe.each(['source', 'dist'] as const)('%s entrypoint', (surface) => {
  const entrypointArgs = actionEntrypointArguments(path.resolve(__dirname, '..'), surface);
  const run = (paths: ReturnType<typeof workspace>, env: Record<string, string>, routes: Record<string, Buffer>) =>
    runProvisionerEntrypoint(paths.root, entrypointArgs, {
      'INPUT_GH-VERSION': version, RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64',
      RUNNER_TEMP: paths.runnerTemp, GITHUB_PATH: paths.githubPath, ...env,
    }, routes);
  const expectStopped = (outcome: ReturnType<typeof run>, paths: ReturnType<typeof workspace>, stage: string) => {
    expect(outcome.result.status).toBe(1);
    expect(failureDiagnostic(outcome.result.stderr)).toMatchObject({ classification: { subject: 'ci-gh-provisioner', stage, reason: 'gh-provision-failed' } });
    expect(readGithubPath(paths.githubPath)).toBeUndefined();
  };

  test('Action rejects an invalid version as provisioning failure', () => {
    const paths = workspace();
    const result = spawnSync(process.execPath, [...entrypointArgs], {
      encoding: 'utf8',
      env: {
        ...process.env,
        'INPUT_GH-VERSION': 'not-exact',
        RUNNER_OS: 'Linux',
        RUNNER_ARCH: 'X64',
        RUNNER_TEMP: paths.runnerTemp,
        GITHUB_PATH: paths.githubPath,
        GITHUB_ACTIONS: 'true',
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/gh-provision-failed/);
    const line = result.stderr.split('\n').find((value) => value.startsWith('ci-failure-diagnostic:'));
    expect(JSON.parse(line?.slice('ci-failure-diagnostic:'.length) ?? '{}')).toMatchObject({
      classification: { subject: 'ci-gh-provisioner', stage: 'version-validation' },
      'execution-state': { write: 'not-started' },
      comparison: { field: 'version', expected: 'exact-numeric-version' },
    });
    expect(readGithubPath(paths.githubPath)).toBeUndefined();
    expect(provisionedDirectories(paths.runnerTemp)).toStrictEqual([]);
  });

  for (const [arch, platform] of [['X64', 'linux_amd64'], ['ARM64', 'linux_arm64']] as const) {
    test(`Action installs the checksummed Linux/${arch} asset and exports its directory`, () => {
      // Arrange
      const paths = workspace();
      const asset = archive(paths.root, platform);
      // Act
      const outcome = run(paths, { RUNNER_ARCH: arch }, {
        [checksumUrl]: manifest(sha256(asset), assetName(platform)),
        [`${releaseUrl}/${assetName(platform)}`]: asset,
      });
      // Assert
      expect(outcome.result.status, outcome.result.stderr).toBe(0);
      const exported = readGithubPath(paths.githubPath)?.trim() ?? '';
      expect(path.dirname(exported)).toBe(paths.runnerTemp);
      expect(readdirSync(exported)).toStrictEqual(['gh']);
      expect(readFileSync(path.join(exported, 'gh'), 'utf8')).toBe('gh fixture');
      expect(statSync(path.join(exported, 'gh')).mode & 0o111).toBe(0o111);
      expect(outcome.requested).toStrictEqual([checksumUrl, `${releaseUrl}/${assetName(platform)}`]);
    });
  }

  test('Action rejects a checksum mismatch without exposing a binary', () => {
    // Arrange
    const paths = workspace();
    const asset = archive(paths.root, 'linux_amd64');
    // Act
    const outcome = run(paths, {}, {
      [checksumUrl]: manifest('0'.repeat(64), assetName('linux_amd64')),
      [`${releaseUrl}/${assetName('linux_amd64')}`]: asset,
    });
    // Assert
    expectStopped(outcome, paths, 'checksum-validation');
    expect(provisionedDirectories(paths.runnerTemp)).toStrictEqual([]);
  });

  test('Action rejects an unsupported runner before download or PATH handoff', () => {
    // Arrange
    const paths = workspace();
    // Act
    const outcome = run(paths, { RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64' }, {});
    // Assert
    expectStopped(outcome, paths, 'download-verify-install');
    expect(outcome.requested).toStrictEqual([]);
    expect(provisionedDirectories(paths.runnerTemp)).toStrictEqual([]);
  });

  test('Action reports an unavailable release asset before PATH handoff', () => {
    // Arrange
    const paths = workspace();
    // Act
    const outcome = run(paths, {}, { [checksumUrl]: manifest('0'.repeat(64), assetName('linux_amd64')) });
    // Assert
    expectStopped(outcome, paths, 'asset-download');
    expect(provisionedDirectories(paths.runnerTemp)).toStrictEqual([]);
  });

  test('Action rejects a checksum manifest without the asset entry', () => {
    // Arrange
    const paths = workspace();
    const asset = archive(paths.root, 'linux_amd64');
    // Act
    const outcome = run(paths, {}, { [checksumUrl]: Buffer.from(''), [`${releaseUrl}/${assetName('linux_amd64')}`]: asset });
    // Assert
    expectStopped(outcome, paths, 'checksum-inventory');
    expect(provisionedDirectories(paths.runnerTemp)).toStrictEqual([]);
  });

  test('Action rejects an extraction failure before PATH handoff', () => {
    // Arrange
    const paths = workspace();
    const asset = Buffer.from('not an archive');
    // Act
    const outcome = run(paths, {}, { [checksumUrl]: manifest(sha256(asset), assetName('linux_amd64')), [`${releaseUrl}/${assetName('linux_amd64')}`]: asset });
    // Assert
    expectStopped(outcome, paths, 'asset-install');
    expect(provisionedDirectories(paths.runnerTemp)).toStrictEqual([]);
  });

  test('Action rejects an installation failure before PATH handoff', () => {
    // Arrange
    const paths = workspace();
    const asset = archive(paths.root, 'linux_amd64');
    // Act
    const outcome = run(paths, { RUNNER_TEMP: path.join(paths.root, 'missing') }, {
      [checksumUrl]: manifest(sha256(asset), assetName('linux_amd64')),
      [`${releaseUrl}/${assetName('linux_amd64')}`]: asset,
    });
    // Assert
    expectStopped(outcome, paths, 'install-directory');
    expect(existsSync(path.join(paths.root, 'missing'))).toBe(false);
  });

  test('Action removes the installed binary when PATH update fails', () => {
    // Arrange
    const paths = workspace();
    const asset = archive(paths.root, 'linux_amd64');
    mkdirSync(paths.githubPath);
    // Act
    const outcome = run(paths, {}, {
      [checksumUrl]: manifest(sha256(asset), assetName('linux_amd64')),
      [`${releaseUrl}/${assetName('linux_amd64')}`]: asset,
    });
    // Assert
    expect(outcome.result.status).toBe(1);
    expect(failureDiagnostic(outcome.result.stderr)).toMatchObject({ classification: { subject: 'ci-gh-provisioner', stage: 'path-export' } });
    expect(readdirSync(paths.githubPath)).toStrictEqual([]);
    expect(provisionedDirectories(paths.runnerTemp)).toStrictEqual([]);
  });
});
