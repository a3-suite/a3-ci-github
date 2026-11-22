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
  });

  const installChecksummedAsset = (arch: string, platform: string) => {
    // Arrange
    const paths = workspace();
    const asset = archive(paths.root, platform);
    // Act
    const outcome = run(paths, { RUNNER_ARCH: arch }, {
      [checksumUrl]: manifest(sha256(asset), assetName(platform)),
      [`${releaseUrl}/${assetName(platform)}`]: asset,
    });
    return { paths, outcome };
  };

  for (const [arch, platform] of [['X64', 'linux_amd64'], ['ARM64', 'linux_arm64']] as const) {
    test(`Action installs the checksummed Linux/${arch} asset and exports its directory`, () => {
      const { paths, outcome } = installChecksummedAsset(arch, platform);
      // Assert
      expect(outcome.result.status, outcome.result.stderr).toBe(0);
      const exported = readGithubPath(paths.githubPath)?.trim() ?? '';
      expect(path.dirname(exported)).toBe(paths.runnerTemp);
      expect(readdirSync(exported)).toStrictEqual(['gh']);
      expect(readFileSync(path.join(exported, 'gh'), 'utf8')).toBe('gh fixture');
      expect(statSync(path.join(exported, 'gh')).mode & 0o111).toBe(0o111);
    });

    // evidence_role: supplemental
    // The requests made to the release are an implementation detail that no contract guarantee covers.
    test(`Action requests the checksum manifest then the Linux/${arch} asset`, () => {
      const { outcome } = installChecksummedAsset(arch, platform);
      // Assert
      expect(outcome.result.status, outcome.result.stderr).toBe(0);
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
  });

  test('Action rejects an unsupported runner before download or PATH handoff', () => {
    // Arrange
    const paths = workspace();
    // Act
    const outcome = run(paths, { RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64' }, {});
    // Assert
    expectStopped(outcome, paths, 'download-verify-install');
  });

  test('Action reports an unavailable release asset before PATH handoff', () => {
    // Arrange
    const paths = workspace();
    // Act
    const outcome = run(paths, {}, { [checksumUrl]: manifest('0'.repeat(64), assetName('linux_amd64')) });
    // Assert
    expectStopped(outcome, paths, 'asset-download');
  });

  test('Action rejects a checksum manifest without the asset entry', () => {
    // Arrange
    const paths = workspace();
    const asset = archive(paths.root, 'linux_amd64');
    // Act
    const outcome = run(paths, {}, { [checksumUrl]: Buffer.from(''), [`${releaseUrl}/${assetName('linux_amd64')}`]: asset });
    // Assert
    expectStopped(outcome, paths, 'checksum-inventory');
  });

  test('Action rejects an extraction failure before PATH handoff', () => {
    // Arrange
    const paths = workspace();
    const asset = Buffer.from('not an archive');
    // Act
    const outcome = run(paths, {}, { [checksumUrl]: manifest(sha256(asset), assetName('linux_amd64')), [`${releaseUrl}/${assetName('linux_amd64')}`]: asset });
    // Assert
    expectStopped(outcome, paths, 'asset-install');
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
  });

  test('Action preserves existing PATH entries when final handoff fails', () => {
    const paths = workspace();
    const asset = archive(paths.root, 'linux_amd64');
    writeFileSync(paths.githubPath, '/prior/bin\n');
    const outcome = run(paths, { TEST_FAIL_PATH_RENAME: 'true' }, {
      [checksumUrl]: manifest(sha256(asset), assetName('linux_amd64')),
      [`${releaseUrl}/${assetName('linux_amd64')}`]: asset,
    });
    expect(outcome.result.status).toBe(1);
    expect(failureDiagnostic(outcome.result.stderr)).toMatchObject({ classification: { stage: 'path-export' } });
    expect(readGithubPath(paths.githubPath)).toBe('/prior/bin\n');
  });

  // evidence_role: supplemental
  // The requests made to the release and the working directories left behind are implementation details that no contract guarantee covers.
  describe('Action leaves no working directory after a rejected provisioning', () => {
    type Paths = ReturnType<typeof workspace>;
    const routes = (paths: Paths, digest?: string): Record<string, Buffer> => {
      const asset = archive(paths.root, 'linux_amd64');
      return { [checksumUrl]: manifest(digest ?? sha256(asset), assetName('linux_amd64')), [`${releaseUrl}/${assetName('linux_amd64')}`]: asset };
    };
    const rejections: Array<[string, Record<string, string>, (paths: Paths) => Record<string, Buffer>]> = [
      ['an invalid version', { 'INPUT_GH-VERSION': 'not-exact' }, () => ({})],
      ['a checksum mismatch', {}, (paths) => routes(paths, '0'.repeat(64))],
      ['an unsupported runner', { RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64' }, () => ({})],
      ['an unavailable asset', {}, () => ({ [checksumUrl]: manifest('0'.repeat(64), assetName('linux_amd64')) })],
      ['a manifest without the asset entry', {}, (paths) => ({ ...routes(paths), [checksumUrl]: Buffer.from('') })],
      ['an extraction failure', {}, () => { const asset = Buffer.from('not an archive'); return { [checksumUrl]: manifest(sha256(asset), assetName('linux_amd64')), [`${releaseUrl}/${assetName('linux_amd64')}`]: asset }; }],
    ];
    test.each(rejections)('%s', (_name, env, routesFor) => {
      // Arrange
      const paths = workspace();
      // Act
      const outcome = run(paths, env, routesFor(paths));
      // Assert
      expect(outcome.result.status).toBe(1);
      expect(provisionedDirectories(paths.runnerTemp)).toStrictEqual([]);
    });

    test('an unsupported runner makes no request', () => {
      // Arrange
      const paths = workspace();
      // Act
      const outcome = run(paths, { RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64' }, {});
      // Assert
      expect(outcome.requested).toStrictEqual([]);
    });

    test('an installation failure does not create the missing runner temporary directory', () => {
      // Arrange
      const paths = workspace();
      // Act
      const outcome = run(paths, { RUNNER_TEMP: path.join(paths.root, 'missing') }, routes(paths));
      // Assert
      expect(outcome.result.status).toBe(1);
      expect(existsSync(path.join(paths.root, 'missing'))).toBe(false);
    });

    test('a failed PATH update', () => {
      // Arrange
      const paths = workspace();
      mkdirSync(paths.githubPath);
      // Act
      const outcome = run(paths, {}, routes(paths));
      // Assert
      expect(outcome.result.status).toBe(1);
      expect(provisionedDirectories(paths.runnerTemp)).toStrictEqual([]);
    });
  });
});
