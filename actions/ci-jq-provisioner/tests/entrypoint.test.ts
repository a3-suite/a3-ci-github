// flow_id: ci-jq-provisioner-entrypoint
// test_level: e2e
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, test, expect } from 'vitest';

import { actionEntrypointArguments } from '../../../tests/support/action-entrypoint';
import { provisionerWorkspace, readGithubPath, runProvisionerEntrypoint } from '../../../tests/support/provisioner-entrypoint';

const version = '1.7.1';
const releaseUrl = `https://github.com/jqlang/jq/releases/download/jq-${version}`;
const checksumUrl = `${releaseUrl}/sha256sum.txt`;
// Each platform asset has distinct content so that exposing another platform's asset is detectable.
const binaryFor = (asset: string): Buffer => Buffer.from(`jq fixture ${asset}`);
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function workspace(): { root: string; runnerTemp: string; githubPath: string } {
  const root = provisionerWorkspace(path.resolve(__dirname, 'tmp'), 'ci-jq-entrypoint-');
  roots.push(root);
  const runnerTemp = path.join(root, 'runner-temp');
  mkdirSync(runnerTemp);
  return { root, runnerTemp, githubPath: path.join(root, 'github-path') };
}

const manifest = (digest: string, asset: string): Buffer => Buffer.from(`${digest}  ${asset}\n`);
const sha256 = (value: Buffer): string => createHash('sha256').update(value).digest('hex');
const releaseRoutes = (asset: string, digest = sha256(binaryFor(asset))): Record<string, Buffer> => ({
  [checksumUrl]: manifest(digest, asset),
  [`${releaseUrl}/${asset}`]: binaryFor(asset),
});
const failureDiagnostic = (stderr: string): unknown => {
  const line = stderr.split('\n').find((value) => value.startsWith('ci-failure-diagnostic:'));
  return JSON.parse(line?.slice('ci-failure-diagnostic:'.length) ?? '{}');
};
const provisionedDirectories = (runnerTemp: string): string[] => readdirSync(runnerTemp).filter((entry) => entry.startsWith('ci-jq-'));

describe.each(['source', 'dist'] as const)('%s entrypoint', (surface) => {
  const entrypointArgs = actionEntrypointArguments(path.resolve(__dirname, '..'), surface);
  const run = (paths: ReturnType<typeof workspace>, env: Record<string, string>, routes: Record<string, Buffer>) =>
    runProvisionerEntrypoint(paths.root, entrypointArgs, {
      'INPUT_JQ-VERSION': version, RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64',
      RUNNER_TEMP: paths.runnerTemp, GITHUB_PATH: paths.githubPath, ...env,
    }, routes);
  const expectStopped = (outcome: ReturnType<typeof run>, paths: ReturnType<typeof workspace>, stage: string) => {
    expect(outcome.result.status).toBe(1);
    expect(failureDiagnostic(outcome.result.stderr)).toMatchObject({ classification: { subject: 'ci-jq-provisioner', stage, reason: 'jq-provision-failed' } });
    expect(readGithubPath(paths.githubPath)).toBeUndefined();
  };

  test('Action rejects an invalid version as provisioning failure', () => {
    const paths = workspace();
    const result = spawnSync(process.execPath, [...entrypointArgs], {
      encoding: 'utf8',
      env: {
        ...process.env,
        'INPUT_JQ-VERSION': 'not-exact',
        RUNNER_OS: 'Linux',
        RUNNER_ARCH: 'X64',
        RUNNER_TEMP: paths.runnerTemp,
        GITHUB_PATH: paths.githubPath,
        GITHUB_ACTIONS: 'true',
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/jq-provision-failed/);
    expect(failureDiagnostic(result.stderr)).toMatchObject({
      classification: { subject: 'ci-jq-provisioner', stage: 'version-validation' },
      'execution-state': { write: 'not-started' },
      comparison: { field: 'version', expected: 'exact-numeric-version' },
    });
    expect(readGithubPath(paths.githubPath)).toBeUndefined();
  });

  test('Action preserves existing PATH entries when final handoff fails', () => {
    const paths = workspace();
    writeFileSync(paths.githubPath, '/prior/bin\n');
    const outcome = run(paths, { TEST_FAIL_PATH_RENAME: 'true' }, releaseRoutes('jq-linux-amd64'));
    expect(outcome.result.status).toBe(1);
    expect(failureDiagnostic(outcome.result.stderr)).toMatchObject({ classification: { stage: 'path-export' } });
    expect(readGithubPath(paths.githubPath)).toBe('/prior/bin\n');
  });

  for (const [runnerOs, arch, asset] of [['Linux', 'X64', 'jq-linux-amd64'], ['macOS', 'ARM64', 'jq-macos-arm64']] as const) {
    test(`Action installs the checksummed ${runnerOs}/${arch} asset and exports its directory`, () => {
      // Arrange
      const paths = workspace();
      // Act
      const outcome = run(paths, { RUNNER_OS: runnerOs, RUNNER_ARCH: arch }, releaseRoutes(asset));
      // Assert
      expect(outcome.result.status, outcome.result.stderr).toBe(0);
      const exported = readGithubPath(paths.githubPath)?.trim() ?? '';
      expect(path.dirname(exported)).toBe(paths.runnerTemp);
      expect(readdirSync(exported)).toStrictEqual(['jq']);
      expect(readFileSync(path.join(exported, 'jq'))).toStrictEqual(binaryFor(asset));
      expect(statSync(path.join(exported, 'jq')).mode & 0o111).toBe(0o111);
    });
  }

  test('Action rejects a checksum mismatch without exposing a binary', () => {
    // Arrange
    const paths = workspace();
    // Act
    const outcome = run(paths, {}, releaseRoutes('jq-linux-amd64', '0'.repeat(64)));
    // Assert
    expectStopped(outcome, paths, 'checksum-validation');
  });

  test('Action rejects an unsupported runner before download or PATH handoff', () => {
    // Arrange
    const paths = workspace();
    // Act
    const outcome = run(paths, { RUNNER_OS: 'Windows', RUNNER_ARCH: 'ARM64' }, {});
    // Assert
    expectStopped(outcome, paths, 'download-verify-install');
  });

  test('Action reports an unavailable release asset before PATH handoff', () => {
    // Arrange
    const paths = workspace();
    // Act
    const outcome = run(paths, {}, { [checksumUrl]: manifest(sha256(binaryFor('jq-linux-amd64')), 'jq-linux-amd64') });
    // Assert
    expectStopped(outcome, paths, 'asset-download');
  });

  test('Action rejects a checksum manifest without the asset entry', () => {
    // Arrange
    const paths = workspace();
    // Act
    const outcome = run(paths, {}, { [checksumUrl]: Buffer.from(''), [`${releaseUrl}/jq-linux-amd64`]: binaryFor('jq-linux-amd64') });
    // Assert
    expectStopped(outcome, paths, 'checksum-inventory');
  });

  test('Action rejects unset runner paths before provisioning', () => {
    for (const unset of ['RUNNER_TEMP', 'GITHUB_PATH']) {
      // Arrange
      const paths = workspace();
      // Act
      const outcome = run(paths, { [unset]: '' }, {});
      // Assert
      expect(outcome.result.status, unset).toBe(1);
      expect(failureDiagnostic(outcome.result.stderr), unset).toMatchObject({ classification: { subject: 'ci-jq-provisioner', stage: 'input-validation', reason: 'jq-provision-failed-runner-paths-unavailable' } });
      expect(readGithubPath(paths.githubPath), unset).toBeUndefined();
      expect(provisionedDirectories(paths.runnerTemp), unset).toEqual([]);
    }
  });

  test('Action rejects an installation failure before PATH handoff', () => {
    // Arrange
    const paths = workspace();
    // Act
    const outcome = run(paths, { RUNNER_TEMP: path.join(paths.root, 'missing') }, releaseRoutes('jq-linux-amd64'));
    // Assert
    expectStopped(outcome, paths, 'install-directory');
  });

  test('Action removes the installed binary when PATH update fails', () => {
    // Arrange
    const paths = workspace();
    mkdirSync(paths.githubPath);
    // Act
    const outcome = run(paths, {}, releaseRoutes('jq-linux-amd64'));
    // Assert
    expect(outcome.result.status).toBe(1);
    expect(failureDiagnostic(outcome.result.stderr)).toMatchObject({ classification: { subject: 'ci-jq-provisioner', stage: 'path-export' } });
    expect(readdirSync(paths.githubPath)).toStrictEqual([]);
    expect(provisionedDirectories(paths.runnerTemp)).toStrictEqual([]);
  });



  // evidence_role: supplemental
  // The requests made to the release and the working directories left behind are implementation details that no contract guarantee covers.
  test('Action makes no request and leaves no working directory for an unsupported runner', () => {
    // Arrange
    const paths = workspace();
    // Act
    const outcome = run(paths, { RUNNER_OS: 'Windows', RUNNER_ARCH: 'ARM64' }, {});
    // Assert
    expect(outcome.requested).toStrictEqual([]);
    expect(provisionedDirectories(paths.runnerTemp)).toStrictEqual([]);
  });

  // evidence_role: supplemental
  // The requests made to the release and the working directories left behind are implementation details that no contract guarantee covers.
  describe('Action leaves no working directory after a rejected provisioning', () => {
    const asset = 'jq-linux-amd64';
    const rejections: Array<[string, Record<string, string>, Record<string, Buffer>]> = [
      ['an invalid version', { 'INPUT_JQ-VERSION': 'not-exact' }, {}],
      ['a checksum mismatch', {}, releaseRoutes(asset, '0'.repeat(64))],
      ['an unavailable asset', {}, { [checksumUrl]: manifest(sha256(binaryFor(asset)), asset) }],
      ['a manifest without the asset entry', {}, { [checksumUrl]: Buffer.from(''), [`${releaseUrl}/${asset}`]: binaryFor(asset) }],
    ];
    test.each(rejections)('%s', (_name, env, routes) => {
      // Arrange
      const paths = workspace();
      // Act
      const outcome = run(paths, env, routes);
      // Assert
      expect(outcome.result.status).toBe(1);
      expect(provisionedDirectories(paths.runnerTemp)).toStrictEqual([]);
    });



    test('a missing install directory', () => {
      // Arrange
      const paths = workspace();
      // Act
      const outcome = run(paths, { RUNNER_TEMP: path.join(paths.root, 'missing') }, releaseRoutes(asset));
      // Assert
      expect(outcome.result.status).toBe(1);
      expect(existsSync(path.join(paths.root, 'missing'))).toBe(false);
    });
  });
});
