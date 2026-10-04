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
import os from 'node:os';
import path from 'node:path';
import { test, describe, expect } from 'vitest';
import { fileURLToPath } from 'node:url';

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(scriptRoot, '../..');
const hasPwsh = spawnSync('pwsh', ['--version'], { encoding: 'utf8' }).status === 0;

const withFixture = (callback) => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'a3-ci-github-rust-release-'));
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

const sha256 = (content) => createHash('sha256').update(content.replaceAll('\r', '')).digest('hex');

describe("contract.ci-rust-release-build.processing", () => {
  describe("rust-release-build-script", () => {
    // contract_id: contract.ci-rust-release-build.processing
    // integration_id: rust-release-build-script
    test.each(['src/verify-platform-manifest.mjs', 'dist/index.mjs'])('platform verifier %s rejects an unbound selection', (entrypoint) => withFixture((fixture) => {
      // Arrange
      const manifest = path.join(fixture, 'platforms.yml');
      writeFileSync(manifest, 'platforms: [{id: linux-x64, runner: ubuntu-24.04, target: x86_64-unknown-linux-gnu}]\n');
      const executable = path.join(scriptRoot, entrypoint);
      // Catch the CLI error before Node prints a minified bundle as its code frame.
      const invocation = ['--input-type=module', '--eval', "import { pathToFileURL } from 'node:url'; try { await import(pathToFileURL(process.argv[1]).href); } catch (error) { console.error(error.message); process.exitCode = 1; }", executable];
      // Act
      const accepted = run(process.execPath, [...invocation, manifest, 'linux-x64', 'x86_64-unknown-linux-gnu']);
      const missingId = run(process.execPath, [...invocation, manifest, 'unknown', 'x86_64-unknown-linux-gnu']);
      const wrongTarget = run(process.execPath, [...invocation, manifest, 'linux-x64', 'wrong-target']);
      // Assert
      expect(accepted.status, accepted.stderr).toBe(0);
      expect(missingId.status).not.toBe(0);
      expect(missingId.stderr).toMatch(/selected platform id is not present/);
      expect(wrongTarget.status).not.toBe(0);
      expect(wrongTarget.stderr).toMatch(/selected platform target does not match/);
      for (const args of [[], [manifest], [manifest, 'linux-x64']]) {
        const incomplete = run(process.execPath, [...invocation, ...args]);
        expect(incomplete.status).not.toBe(0);
        expect(incomplete.stderr).toMatch(/usage:/);
      }
    }));
  });
});

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

describe("contract.ci-rust-source-gate.processing", () => {
  describe("rust-source-gate-script", () => {
    // contract_id: contract.ci-rust-source-gate.processing
    // integration_id: rust-source-gate-script
    test('source gate accepts the bound checkout and rejects a different source SHA', () => withFixture((fixture) => {
      // Arrange
      const authority = path.join(fixture, 'authority.json');
      const sourceSha = initializeGitFixture(fixture);
      writeFileSync(authority, JSON.stringify({ language_profile: 'rust', source_sha: sourceSha }));

      // Act
      const accepted = run(path.join(scriptRoot, 'ci-source-gate.sh'), ['rust', authority], { cwd: fixture });
      // Assert
      expect(accepted.status, accepted.stderr).toBe(0);

      // Arrange
      writeFileSync(authority, JSON.stringify({ language_profile: 'rust', source_sha: 'a'.repeat(40) }));
      // Act
      const rejected = run(path.join(scriptRoot, 'ci-source-gate.sh'), ['rust', authority], { cwd: fixture });
      // Assert
      expect(rejected.status).not.toBe(0);
    }));
  });
});

describe("contract.ci-rust-release-build.processing", () => {
  describe("rust-release-build-script", () => {
    // contract_id: contract.ci-rust-release-build.processing
    // integration_id: rust-release-build-script
    test('release build binds exact toolchain and a unique manifest platform before building', () => withFixture((fixture) => {
      // Arrange
      const sourceSha = initializeGitFixture(fixture);
      const isLinux = process.platform === 'linux';
      const platformId = isLinux ? 'linux-x64' : 'macos-x64';
      const platformTarget = isLinux ? 'x86_64-unknown-linux-gnu' : 'x86_64-apple-darwin';
      const mismatchedTarget = isLinux ? 'aarch64-unknown-linux-gnu' : 'aarch64-apple-darwin';
      const runner = isLinux ? 'ubuntu-24.04' : 'macos-14';
      const manifestPath = path.join(fixture, 'platform-manifest.yml');
      const manifestText = `platforms:\n  - {id: ${platformId}, runner: ${runner}, target: ${platformTarget}}\n`;
      writeFileSync(manifestPath, manifestText);
      const cargoManifest = path.join(fixture, 'Cargo.toml');
      writeFileSync(cargoManifest, "[package]\nname='example-cli'\nversion='0.3.0'\n");
      const authorityPath = path.join(fixture, 'authority.json');
      const writeAuthority = (toolchain, platformManifest = manifestPath, content = manifestText) => {
        writeFileSync(authorityPath, JSON.stringify({
          language_profile: 'rust',
          toolchain_version: toolchain,
          platform_manifest: platformManifest,
          platform_manifest_sha256: sha256(content),
          source_sha: sourceSha,
          version: '0.3.0',
        }));
      };
      writeAuthority('1.90.0');

      const fakeBin = path.join(fixture, 'bin');
      const targetDirectory = path.join(fixture, 'target');
      mkdirSync(fakeBin);
      const rustup = path.join(fakeBin, 'rustup');
      writeFileSync(rustup, '#!/usr/bin/env bash\nexit 0\n');
      chmodSync(rustup, 0o755);
      const cargo = path.join(fakeBin, 'cargo');
      writeFileSync(cargo, [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'if [[ " $* " == *" metadata "* ]]; then',
        "  jq -n --arg manifest \"$FAKE_MANIFEST\" --arg target \"$FAKE_TARGET_DIR\" '{packages:[{manifest_path:$manifest,version:\"0.3.0\"}],target_directory:$target}'",
        '  exit 0',
        'fi',
        'mkdir -p "$FAKE_TARGET_DIR/$FAKE_TARGET/release"',
        "cat > \"$FAKE_TARGET_DIR/$FAKE_TARGET/release/example-cli\" <<'SCRIPT'",
        '#!/usr/bin/env bash',
        'if [[ -n "${FAKE_VERSION_OUTPUT:-}" ]]; then',
        '  if [[ "${FAKE_VERSION_STREAM:-stdout}" == "stderr" ]]; then',
        "    printf '%s\\n' \"$FAKE_VERSION_OUTPUT\" >&2",
        '  else',
        "    printf '%s\\n' \"$FAKE_VERSION_OUTPUT\"",
        '  fi',
        'fi',
        'exit "${FAKE_VERSION_EXIT_CODE:-0}"',
        'SCRIPT',
        'chmod +x "$FAKE_TARGET_DIR/$FAKE_TARGET/release/example-cli"',
        '',
      ].join('\n'));
      chmodSync(cargo, 0o755);
      const environment = {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
        CI_CARGO_MANIFEST_PATH: cargoManifest,
        CI_RELEASE_BINARY_NAME: 'example-cli',
        CI_RELEASE_ASSET_PREFIX: 'example-cli',
        FAKE_MANIFEST: cargoManifest,
        FAKE_TARGET_DIR: targetDirectory,
        FAKE_TARGET: platformTarget,
        FAKE_VERSION_OUTPUT: 'a3-sdd 0.3.0',
      };
      const args = (toolchain, target, output) => [
        'rust', manifestPath, toolchain, platformId, target, authorityPath, output,
      ];
      const runBuild = (buildArgs, options = {}) => run(
        path.join(scriptRoot, 'ci-release-build.sh'),
        buildArgs,
        { cwd: fixture, ...options },
      );

      // Act
      const accepted = runBuild(args(
        '1.90.0', platformTarget, path.join(fixture, 'accepted-output'),
      ), { env: environment });
      // Assert
      expect(accepted.status, accepted.stderr).toBe(0);

      // Act + Assert: the authority version is accepted as an independent token in the --version output.
      const tokenOutputs = ['a3-sdd 0.3.0', 'v0.3.0', 'V0.3.0', '0.3.0', 'a3-sdd 0.3.0\n(commit abc)', 'a3-sdd\t0.3.0', 'a3-sdd\r0.3.0'];
      for (const [index, output] of tokenOutputs.entries()) {
        const acceptedOutput = runBuild(args(
          '1.90.0', platformTarget, path.join(fixture, `version-accepted-${index}`),
        ), { env: { ...environment, FAKE_VERSION_OUTPUT: output } });
        expect(acceptedOutput.status, `${output}: ${acceptedOutput.stderr}`).toBe(0);
      }

      // Act + Assert: a version token reported on stderr is accepted through the stdout -> stderr concatenation.
      const stderrVersion = runBuild(args(
        '1.90.0', platformTarget, path.join(fixture, 'version-accepted-stderr'),
      ), { env: { ...environment, FAKE_VERSION_OUTPUT: '0.3.0', FAKE_VERSION_STREAM: 'stderr' } });
      expect(stderrVersion.status, stderrVersion.stderr).toBe(0);

      // Act + Assert: outputs without the authority version as a token fail with the stable diagnostic.
      const rejectedOutputs = ['0.3.1', '10.3.0', 'v0.3.0-rc1', '', '(0.3.0)', 'a3-sdd v0.3.0-rc1'];
      for (const [index, output] of rejectedOutputs.entries()) {
        const rejectedOutput = runBuild(args(
          '1.90.0', platformTarget, path.join(fixture, `version-rejected-${index}`),
        ), { env: { ...environment, FAKE_VERSION_OUTPUT: output } });
        expect(rejectedOutput.status, `${output} should be rejected`).not.toBe(0);
        expect(rejectedOutput.stderr).toMatch(/binary-version-mismatch/);
        expect(rejectedOutput.stderr).toMatch(/expected=/);
        expect(rejectedOutput.stderr).toMatch(/received=/);
      }

      // Act + Assert: a non-zero version command fails even when the output contains the token.
      const failedVersionCommand = runBuild(args(
        '1.90.0', platformTarget, path.join(fixture, 'version-failed-command'),
      ), { env: { ...environment, FAKE_VERSION_OUTPUT: 'a3-sdd 0.3.0', FAKE_VERSION_EXIT_CODE: '1' } });
      expect(failedVersionCommand.status).not.toBe(0);
      expect(failedVersionCommand.stderr).toMatch(/binary-version-mismatch/);
      expect(failedVersionCommand.stderr).toMatch(/received=/);

      // Act
      const targetMismatch = runBuild(args(
        '1.90.0', mismatchedTarget, path.join(fixture, 'mismatch-output'),
      ), { env: environment });
      // Assert
      expect(targetMismatch.status).not.toBe(0);

      // Arrange
      writeAuthority('stable');
      // Act
      const mutableToolchain = runBuild(args(
        'stable', platformTarget, path.join(fixture, 'stable-output'),
      ), { env: environment });
      // Assert
      expect(mutableToolchain.status).not.toBe(0);

      // Arrange
      const duplicateText = [
        'platforms:',
        `  - {id: ${platformId}, runner: ${runner}, target: ${platformTarget}}`,
        `  - {id: ${platformId}, runner: ${runner}, target: ${mismatchedTarget}}`,
        '',
      ].join('\n');
      writeFileSync(manifestPath, duplicateText);
      writeAuthority('1.90.0', manifestPath, duplicateText);
      // Act
      const duplicate = runBuild(args(
        '1.90.0', platformTarget, path.join(fixture, 'duplicate-output'),
      ), { env: environment });
      // Assert
      expect(duplicate.status).not.toBe(0);
    }));

    // contract_id: contract.ci-rust-release-build.processing
    // integration_id: rust-release-build-script
    test('Unix package and verification bind archive, checksum, manifest, and source without overwrite', () => withFixture((fixture) => {
      // Arrange
      const binary = path.join(fixture, 'example-cli');
      const output = path.join(fixture, 'release-output');
      const sourceSha = 'a'.repeat(40);
      writeFileSync(binary, 'release-binary');
      chmodSync(binary, 0o755);

      const packageArgs = [
        binary,
        'example-cli',
        'example-cli',
        '1.2.3',
        'test-x64',
        'x86_64-test-platform',
        sourceSha,
        `${output}${path.sep}`,
      ];
      const verifyArgs = [
        'example-cli',
        'example-cli',
        '1.2.3',
        'test-x64',
        'x86_64-test-platform',
        sourceSha,
        output,
      ];

      // Act
      const created = run(path.join(scriptRoot, 'package-release-unix.sh'), packageArgs);
      // Assert
      expect(created.status, created.stderr).toBe(0);
      // Act
      const verified = run(path.join(scriptRoot, 'verify-release-asset-unix.sh'), verifyArgs);
      // Assert
      expect(verified.status, verified.stderr).toBe(0);

      const manifestPath = path.join(output, 'asset-manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      expect(Object.keys(manifest).sort()).toStrictEqual([
        'assets',
        'kind',
        'platform_id',
        'platform_target',
        'schema_version',
        'source_sha',
        'version',
      ]);
      expect(manifest.kind).toBe('ci-release-build-manifest');
      expect(manifest.source_sha).toBe(sourceSha);
      expect(manifest.assets.length).toBe(1);

      // Arrange
      const archive = path.join(output, manifest.assets[0].path);
      const originalArchive = readFileSync(archive);
      // Act
      const repeated = run(path.join(scriptRoot, 'package-release-unix.sh'), packageArgs);
      // Assert
      expect(repeated.status).not.toBe(0);
      expect(readFileSync(archive)).toStrictEqual(originalArchive);

      // Arrange
      manifest.source_sha = 'b'.repeat(40);
      writeFileSync(manifestPath, JSON.stringify(manifest));
      // Act
      const tampered = run(path.join(scriptRoot, 'verify-release-asset-unix.sh'), verifyArgs);
      // Assert
      expect(tampered.status).not.toBe(0);
    }));

    // contract_id: contract.ci-rust-release-build.processing
    // integration_id: rust-release-build-script
    test('Unix package failure leaves no final or temporary output directory', () => withFixture((fixture) => {
      // Arrange
      const binary = path.join(fixture, 'example-cli');
      const output = path.join(fixture, 'release-output');
      const fakeBin = path.join(fixture, 'bin');
      mkdirSync(fakeBin);
      writeFileSync(binary, 'release-binary');
      chmodSync(binary, 0o755);
      const tar = path.join(fakeBin, 'tar');
      writeFileSync(tar, '#!/usr/bin/env bash\nexit 1\n');
      chmodSync(tar, 0o755);

      // Act
      const failed = run(path.join(scriptRoot, 'package-release-unix.sh'), [
        binary,
        'example-cli',
        'example-cli',
        '1.2.3',
        'test-x64',
        'x86_64-test-platform',
        'a'.repeat(40),
        `${output}${path.sep}`,
      ], { env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` } });

      // Assert
      expect(failed.status).not.toBe(0);
      expect(existsSync(output)).toBe(false);
      expect(readdirSync(fixture).filter((name) => name.startsWith('release-output.tmp.'))).toStrictEqual([]);
    }));

    // contract_id: contract.ci-rust-release-build.processing
    // integration_id: rust-release-build-script
    test('Unix package preserves an output directory created immediately before publication', () => withFixture((fixture) => {
      // Arrange
      const binary = path.join(fixture, 'example-cli');
      const output = path.join(fixture, 'release-output');
      const fakeBin = path.join(fixture, 'bin');
      mkdirSync(fakeBin);
      writeFileSync(binary, 'release-binary');
      chmodSync(binary, 0o755);
      const mkdir = path.join(fakeBin, 'mkdir');
      writeFileSync(mkdir, [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'if [[ "$#" -eq 1 && "$1" == "$RACE_OUTPUT" ]]; then',
        '  /bin/mkdir "$1"',
        '  : > "$1/competitor-owned"',
        '  exit 1',
        'fi',
        'exec /bin/mkdir "$@"',
        '',
      ].join('\n'));
      chmodSync(mkdir, 0o755);

      // Act
      const raced = run(path.join(scriptRoot, 'package-release-unix.sh'), [
        binary,
        'example-cli',
        'example-cli',
        '1.2.3',
        'test-x64',
        'x86_64-test-platform',
        'a'.repeat(40),
        output,
      ], {
        env: {
          ...process.env,
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
          RACE_OUTPUT: output,
        },
      });

      // Assert
      expect(raced.status).not.toBe(0);
      expect(readdirSync(output)).toStrictEqual(['competitor-owned']);
      expect(readdirSync(fixture).filter((name) => name.startsWith('release-output.tmp.'))).toStrictEqual([]);
    }));

    // contract_id: contract.ci-rust-release-build.processing
    // integration_id: rust-release-build-script
    test('Unix package removes its claimed output when publication fails', () => withFixture((fixture) => {
      // Arrange
      const binary = path.join(fixture, 'example-cli');
      const output = path.join(fixture, 'release-output');
      const fakeBin = path.join(fixture, 'bin');
      const moveCount = path.join(fixture, 'move-count');
      mkdirSync(fakeBin);
      writeFileSync(binary, 'release-binary');
      chmodSync(binary, 0o755);
      const mv = path.join(fakeBin, 'mv');
      writeFileSync(mv, [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'count=0',
        'if [[ -f "$MOVE_COUNT" ]]; then count=$(<"$MOVE_COUNT"); fi',
        'count=$((count + 1))',
        'printf "%s" "$count" > "$MOVE_COUNT"',
        'if [[ "$count" -eq 2 ]]; then exit 1; fi',
        'exec /bin/mv "$@"',
        '',
      ].join('\n'));
      chmodSync(mv, 0o755);

      // Act
      const failed = run(path.join(scriptRoot, 'package-release-unix.sh'), [
        binary,
        'example-cli',
        'example-cli',
        '1.2.3',
        'test-x64',
        'x86_64-test-platform',
        'a'.repeat(40),
        output,
      ], {
        env: {
          ...process.env,
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
          MOVE_COUNT: moveCount,
        },
      });

      // Assert
      expect(failed.status).not.toBe(0);
      expect(existsSync(output)).toBe(false);
      expect(readdirSync(fixture).filter((name) => name.startsWith('release-output.tmp.'))).toStrictEqual([]);
    }));
  });
});

describe("rust-release-scripts", () => {
  describe("rust-release-scripts-regression", () => {
    // integration_id: rust-release-scripts-regression
    test('PowerShell package and verification roundtrip when pwsh is available', { skip: !hasPwsh }, () => withFixture((fixture) => {
      // Arrange
      const binary = path.join(fixture, 'example-cli.exe');
      const output = path.join(fixture, 'release-output');
      writeFileSync(binary, 'release-binary');

      const common = [
        binary,
        'example-cli.exe',
        'example-cli',
        '1.2.3',
        'windows-x64',
        'x86_64-pc-windows-msvc',
        'a'.repeat(40),
        `${output}${path.sep}`,
      ];
      // Act
      const created = run('pwsh', ['-NoLogo', '-NoProfile', '-File', path.join(scriptRoot, 'package-release.ps1'), ...common]);
      // Assert
      expect(created.status, created.stderr).toBe(0);
      // Act
      const verified = run('pwsh', [
        '-NoLogo',
        '-NoProfile',
        '-File',
        path.join(scriptRoot, 'verify-release-asset.ps1'),
        ...common.slice(1),
      ]);
      // Assert
      expect(verified.status, verified.stderr).toBe(0);
    }));
  });
});

describe("contract.ci-rust-release-build.processing", () => {
  describe("rust-release-scripts-regression", () => {
    // contract_id: contract.ci-rust-release-build.processing
    // integration_id: rust-release-scripts-regression
    test('PowerShell package failure removes staging and missing or mismatched artifacts fail closed', { skip: !hasPwsh }, () => withFixture((fixture) => {
      // Arrange
      const binary = path.join(fixture, 'example-cli.exe');
      const output = path.join(fixture, 'release-output');
      const sourceSha = 'a'.repeat(40);
      writeFileSync(binary, 'release-binary');
      const packageArgs = [
        binary, 'different-name.exe', 'example-cli', '1.2.3', 'windows-x64',
        'x86_64-pc-windows-msvc', sourceSha, output,
      ];

      // Act
      const failedPackage = run('pwsh', [
        '-NoLogo', '-NoProfile', '-File', path.join(scriptRoot, 'package-release.ps1'), ...packageArgs,
      ]);
      // Assert
      expect(failedPackage.status).not.toBe(0);
      expect(existsSync(output)).toBe(false);
      expect(readdirSync(fixture).filter((name) => name.startsWith('release-output.tmp.'))).toStrictEqual([]);

      // Arrange
      mkdirSync(output);
      const verifyArgs = [
        'example-cli.exe', 'example-cli', '1.2.3', 'windows-x64',
        'x86_64-pc-windows-msvc', sourceSha, output,
      ];
      // Act
      const missingArtifact = run('pwsh', [
        '-NoLogo', '-NoProfile', '-File', path.join(scriptRoot, 'verify-release-asset.ps1'), ...verifyArgs,
      ]);
      // Assert
      expect(missingArtifact.status).not.toBe(0);
      expect(missingArtifact.stderr).toMatch(/release archive missing/);

      // Arrange
      rmSync(output, { recursive: true, force: true });
      const created = run('pwsh', [
        '-NoLogo', '-NoProfile', '-File', path.join(scriptRoot, 'package-release.ps1'),
        binary, 'example-cli.exe', 'example-cli', '1.2.3', 'windows-x64',
        'x86_64-pc-windows-msvc', sourceSha, output,
      ]);
      expect(created.status, created.stderr).toBe(0);
      const assetManifestPath = path.join(output, 'asset-manifest.json');
      const assetManifest = JSON.parse(readFileSync(assetManifestPath, 'utf8'));
      assetManifest.version = '1.2.4';
      writeFileSync(assetManifestPath, JSON.stringify(assetManifest));
      // Act
      const versionMismatch = run('pwsh', [
        '-NoLogo', '-NoProfile', '-File', path.join(scriptRoot, 'verify-release-asset.ps1'), ...verifyArgs,
      ]);
      // Assert
      expect(versionMismatch.status).not.toBe(0);
      expect(versionMismatch.stderr).toMatch(/release asset manifest source or version mismatch/);
    }));

    // contract_id: contract.ci-rust-release-build.processing
    // integration_id: rust-release-scripts-regression
    test('Windows build stops when native toolchain setup fails', { skip: process.platform !== 'win32' || !hasPwsh }, () => withFixture((fixture) => {
      // Arrange
      const sourceSha = initializeGitFixture(fixture);
      const manifestPath = path.join(fixture, 'platform-manifest.yml');
      const manifestText = 'platforms:\n  - {id: windows-x64, runner: windows-2025, target: x86_64-pc-windows-msvc}\n';
      writeFileSync(manifestPath, manifestText);
      const authorityPath = path.join(fixture, 'authority.json');
      writeFileSync(authorityPath, JSON.stringify({
        language_profile: 'rust',
        toolchain_version: '1.90.0',
        platform_manifest: manifestPath,
        platform_manifest_sha256: sha256(manifestText),
        source_sha: sourceSha,
        version: '1.2.3',
      }));
      const fakeBin = path.join(fixture, 'bin');
      mkdirSync(fakeBin);
      writeFileSync(path.join(fakeBin, 'rustup.cmd'), '@exit /b 1\r\n');
      const output = path.join(fixture, 'release-output');
      const environment = {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
        CI_CARGO_MANIFEST_PATH: path.join(fixture, 'Cargo.toml'),
        CI_RELEASE_BINARY_NAME: 'example-cli',
        CI_RELEASE_ASSET_PREFIX: 'example-cli',
      };

      // Act
      const result = run('pwsh', [
        '-NoLogo', '-NoProfile', '-File', path.join(scriptRoot, 'ci-release-build.ps1'),
        'rust', manifestPath, '1.90.0', 'windows-x64', 'x86_64-pc-windows-msvc',
        authorityPath, output,
      ], { cwd: fixture, env: environment });
      // Assert
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/rust toolchain setup failed/);
      expect(existsSync(output)).toBe(false);
    }));
  });
});

describe("rust-release-scripts", () => {
  describe("rust-release-scripts-regression", () => {
    // integration_id: rust-release-scripts-regression
    test('Windows build uses case-sensitive package and binary version token checks', () => {
      // Arrange
      // Act
      const script = readFileSync(path.join(scriptRoot, 'ci-release-build.ps1'), 'utf8');
      // Assert
      expect(script).toMatch(/\$package\.version -cne \$authority\.version/);
      expect(script).toMatch(/\$token -ceq \$authority\.version -or \$token -ceq "v\$\(\$authority\.version\)" -or \$token -ceq "V\$\(\$authority\.version\)"/);
      expect(script).toMatch(/\$binaryVersionOutput -split '\[\\x20\\x09\\x0A\\x0D\]\+'/);
      expect(script).toMatch(/binary-version-mismatch: expected=\$\(\$authority\.version\) or v\$\(\$authority\.version\) or V\$\(\$authority\.version\) received=\$binaryVersionOutput/);
    });

    // integration_id: rust-release-scripts-regression
    test('Windows package verifies staging before publishing the final output directory', () => {
      // Arrange
      // Act
      const script = readFileSync(path.join(scriptRoot, 'package-release.ps1'), 'utf8');
      // Assert
      expect(script).toMatch(/verify-release-asset\.ps1.*\$staging/);
      expect(script).toMatch(/TrimEnd\(\[IO\.Path\]::DirectorySeparatorChar/);
      expect(script).toMatch(/\[IO\.Directory\]::Move\(\$staging, \$outputPath\)/);
      expect(script).toMatch(/\[IO\.Directory\]::Delete\(\$staging, \$true\)/);
    });
  });
});
