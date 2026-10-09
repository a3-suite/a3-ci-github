import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { describe, expect, test, type TestContext } from 'vitest';
import { runSupplemental, type SupplementalOptionsType } from '../../../runtime/release-publication/supplemental';
import { supplementalSelection } from '../../../runtime/release-publication/selection';
import { canonicalJson, sha256 } from '../../../runtime/release-publication/io';
import { assembleRelease } from '../../../runtime/release-publication/assembly';
import { decodePlatformManifest } from '../../ci-release-assembly/src/platform-manifest-decoder';
import { validateHandoffIntegrity } from '../../ci-handoff-integrity/src/integrity';
import { runInstallerCli } from '../../../runtime/installer/cli';

const repository = path.resolve(__dirname, '../../..');
const python = process.platform === 'win32' ? 'python' : 'python3';
const target = process.platform === 'win32' ? 'windows-x86_64' : process.platform === 'darwin' ? 'macos-arm64' : 'linux-x86_64';
const platform = { id: `release-${process.platform}`, runner: process.platform === 'win32' ? 'windows-2022' : process.platform === 'darwin' ? 'macos-14' : 'ubuntu-24.04', target: process.platform === 'win32' ? 'x86_64-pc-windows-msvc' : process.platform === 'darwin' ? 'aarch64-apple-darwin' : 'x86_64-unknown-linux-gnu' };
const archiveName = process.platform === 'win32' ? 'tool.zip' : 'tool.tar.gz';
const assetName = process.platform === 'win32' ? `install-${target}.ps1` : `install-${target}.sh`;
const fixture = (t: TestContext, verificationProfile = 'native-offline-dry-run-v1'): { root: string; options: SupplementalOptionsType; configure: (changes?: Record<string, string>) => void } => {
  const parent = path.join(repository, 'tests/tmp');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(parent, 'standard-installer-')));
  t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = JSON.parse(fs.readFileSync(path.join(repository, 'skills/installer/assets/examples/native-manifest.template.json'), 'utf8'));
  const managed = path.join(root, 'managed');
  manifest.placement = { managedRoot: managed, releasePath: path.join(managed, 'releases/1.0.0'), currentLink: path.join(managed, 'current') };
  manifest.activation = { strategy: 'active-pointer' };
  manifest.concurrency = { lockPath: path.join(managed, 'install.lock') };
  manifest.state = { installStatePath: path.join(managed, 'state/install.state') };
  manifest.compatibility = { requiredInstallerVersion: '2' };
  fs.mkdirSync(path.join(root, 'installer'));
  fs.writeFileSync(path.join(root, 'installer/product.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(root, 'installer/assembly.json'), JSON.stringify({ schemaVersion: 'installer.assembly.v1', useCase: 'github-release-native', verificationProfile, platforms: { [target]: { manifest: 'installer/product.json', assetName } } }));
  execFileSync('git', ['init', '-q', '--object-format=sha1', root]);
  execFileSync('git', ['-C', root, 'add', 'installer']);
  const tree = execFileSync('git', ['-C', root, 'write-tree'], { encoding: 'utf8' }).trim();
  const sourceSha = execFileSync('git', ['-C', root, 'hash-object', '-t', 'commit', '-w', '--stdin'], { input: `tree ${tree}\nauthor Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\n\nfixture\n`, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(root, '.git/HEAD'), `${sourceSha}\n`);
  fs.mkdirSync(path.join(root, 'standard'));
  const archive = path.join(root, 'standard', archiveName);
  const archiveScript = process.platform === 'win32'
    ? 'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],"w") as a: a.writestr("tool.exe",b"fixture executable bytes")'
    : 'import io,sys,tarfile\np=b"#!/bin/sh\\nexit 0\\n"\nwith tarfile.open(sys.argv[1],"w:gz") as a:\n i=tarfile.TarInfo("tool");i.mode=0o755;i.size=len(p);a.addfile(i,io.BytesIO(p))';
  execFileSync(python, ['-c', archiveScript, archive]);
  const checksum = sha256(fs.readFileSync(archive));
  fs.writeFileSync(`${archive}.sha256`, `${checksum}  ${archiveName}\n`);
  fs.writeFileSync(path.join(root, 'standard/asset-manifest.json'), JSON.stringify({ schema_version: '1', kind: 'ci-release-build-manifest', source_sha: sourceSha, version: '1.0.0', platform_id: platform.id, platform_target: platform.target, assets: [{ path: archiveName, sha256: checksum, checksum_path: `${archiveName}.sha256` }] }));
  fs.writeFileSync(path.join(root, 'platform.yml'), `platforms:\n  - id: ${platform.id}\n    runner: ${platform.runner}\n    target: ${platform.target}\n`);
  const configure = (changes: Record<string, string> = {}): void => {
    const values = { CI_PLATFORM_MANIFEST: 'platform.yml', CI_SUPPLEMENTAL_RELEASE_ASSET_ENABLED: 'true', CI_SUPPLEMENTAL_RELEASE_ASSET_CONTRACT: 'ci.release-asset-publication-contract#supplementalAsset', CI_SUPPLEMENTAL_RELEASE_ASSET_OWNER_CONTRACT: 'installer.asset-assembly-evidence-contract', CI_SUPPLEMENTAL_RELEASE_ASSET_IMPLEMENTATION: 'standard-installer', CI_SUPPLEMENTAL_RELEASE_ASSET_CONFIG_PATH: 'installer/assembly.json', ...changes };
    const sources = {};
    const digest = sha256(Buffer.from(canonicalJson({ sources, values })));
    fs.writeFileSync(path.join(root, 'snapshot.json'), JSON.stringify({ schema: 'ci.config-snapshot.v1', sources, values, digest }));
    fs.writeFileSync(path.join(root, 'authority.json'), JSON.stringify({ source_sha: sourceSha, version: '1.0.0', tag: 'v1.0.0', target_identity: 'fixture/tool', publication: { repository: 'fixture/tool', tag: 'v1.0.0', tag_object_sha: 'b'.repeat(40), source_sha: sourceSha, version: '1.0.0', target_identity: 'fixture/tool', body_sha256: sha256(Buffer.from('fixture notes')) }, platform_manifest: 'platform.yml', platform_manifest_sha256: sha256(fs.readFileSync(path.join(root, 'platform.yml'))), config_snapshot_digest: digest }));
  };
  configure();
  return { root, configure, options: { operation: 'build-platform', sourceRoot: root, authorityPath: 'authority.json', snapshotPath: 'snapshot.json', standardBuildRoot: 'standard', outputDirectory: 'platform-output', installerRoot: path.join(repository, 'runtime/installer'), providerRevision: 'a'.repeat(40) } };
};

const prepareAssembly = (f: ReturnType<typeof fixture>): SupplementalOptionsType => {
  fs.mkdirSync(path.join(f.root, 'standard-download'));
  fs.renameSync(path.join(f.root, 'standard'), path.join(f.root, `standard-download/release-build-${platform.id}`));
  fs.mkdirSync(path.join(f.root, 'supplemental-download'));
  fs.renameSync(path.join(f.root, 'platform-output'), path.join(f.root, `supplemental-download/supplemental-build-${platform.id}`));
  return { ...f.options, operation: 'assemble', standardBuildRoot: 'standard-download', supplementalBuildRoot: 'supplemental-download', outputDirectory: 'handoff' };
};

const runDistributedAction = (f: ReturnType<typeof fixture>) => {
  const output = path.join(f.root, 'runner-output');
  fs.writeFileSync(output, '');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output, A3_INSTALLER_PROVIDER_REVISION: 'a'.repeat(40), INPUT_OPERATION: 'build-platform', 'INPUT_SOURCE-ROOT': f.root, 'INPUT_AUTHORITY-PATH': 'authority.json', 'INPUT_SNAPSHOT-PATH': 'snapshot.json', 'INPUT_STANDARD-BUILD-ROOT': 'standard', 'INPUT_OUTPUT-DIRECTORY': 'platform-output', 'INPUT_SUPPLEMENTAL-BUILD-ROOT': '' };
  const result = spawnSync(process.execPath, [path.join(repository, 'actions/ci-release-supplemental-asset/dist/index.js')], { cwd: f.root, encoding: 'utf8', env });
  return { result, output };
};

describe('standard installer', () => {
  describe('assembly', () => {
    test('verifies a native candidate through the Python assembly boundary', (t) => {
      // Arrange
      const f = fixture(t);
      const authority = JSON.parse(fs.readFileSync(path.join(f.root, 'authority.json'), 'utf8'));
      const driver = 'import json,os,runpy,subprocess,sys\nsys.path.insert(0,os.path.dirname(sys.argv[1]))\nassembly=runpy.run_path(sys.argv[1])\ntry: assembly["run"](json.load(sys.stdin))\nexcept subprocess.CalledProcessError as error:\n sys.stderr.write(error.stderr or "")\n raise';
      const output = path.join(f.root, 'native-output');
      // Act
      const result = spawnSync(python, ['-c', driver, path.join(repository, 'runtime/installer/src/assembly.py')], {
        cwd: f.root, encoding: 'utf8', input: JSON.stringify({ operation: 'build-platform', sourceRoot: f.root,
          configPath: path.join(f.root, 'installer/assembly.json'), authority, releasePlatforms: [platform],
          standardBuildRoot: path.join(f.root, 'standard'), outputDirectory: output,
          providerRevision: 'a'.repeat(40), assemblyId: 'native-boundary' }),
      });
      // Assert
      expect(result.status, result.stderr).toBe(0);
      expect(fs.existsSync(path.join(output, 'platform-record.json'))).toBe(true);
    });

    test('verifies native candidate and produces handoff without consumer implementation', (t) => {
      // Arrange
      const f = fixture(t);
      // Act
      runInstallerCli(['--operation', 'build-platform', '--source-root', f.root, '--authority-path', 'authority.json', '--snapshot-path', 'snapshot.json', '--standard-build-root', 'standard', '--output-directory', 'platform-output', '--provider-revision', 'a'.repeat(40)], path.join(repository, 'runtime/installer/dist'));
      const assembled = prepareAssembly(f);
      runInstallerCli(['--operation', 'assemble', '--source-root', f.root, '--authority-path', 'authority.json', '--snapshot-path', 'snapshot.json', '--standard-build-root', assembled.standardBuildRoot, '--supplemental-build-root', assembled.supplementalBuildRoot!, '--output-directory', 'handoff', '--provider-revision', 'a'.repeat(40)], path.join(repository, 'runtime/installer/dist'));
      const releaseRoot = path.join(f.root, 'release-handoff');
      const release = assembleRelease({ authorityPath: path.join(f.root, 'authority.json'), repository: 'fixture/tool', snapshotPath: path.join(f.root, 'snapshot.json'), platformManifestPath: path.join(f.root, 'platform.yml'), platformMatrix: JSON.stringify({ include: [platform] }), buildRoot: path.join(f.root, assembled.standardBuildRoot), supplementalRoot: path.join(f.root, 'handoff'), outputRoot: releaseRoot }, decodePlatformManifest);
      const expected = { sourceSha: release.identity.source_sha, version: release.identity.version, targetIdentity: release.identity.target_identity };
      if (process.env.CI_INSTALLER_ACCEPTANCE_OUTPUT) {
        fs.cpSync(releaseRoot, path.resolve(repository, process.env.CI_INSTALLER_ACCEPTANCE_OUTPUT), { recursive: true });
        if (!process.env.GITHUB_OUTPUT) throw new Error('installer-acceptance-output-missing');
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `source-sha=${expected.sourceSha}\n`);
      }
      const transported = path.join(f.root, 'downloaded-handoff');
      fs.cpSync(releaseRoot, transported, { recursive: true });
      const integrity = validateHandoffIntegrity(transported, 'handoff.json', expected);
      // Assert
      expect(integrity.entries).toBeGreaterThan(0);
      expect(release.assets.map((asset) => asset.name)).toContain(assetName);
      fs.appendFileSync(path.join(transported, 'assets', assetName), '\n# transport corruption\n');
      expect(() => validateHandoffIntegrity(transported, 'handoff.json', expected)).toThrow('handoff-manifest-checksum-mismatch');
      const handoff = JSON.parse(fs.readFileSync(path.join(f.root, 'handoff/supplemental-manifest.json'), 'utf8'));
      expect(handoff.assets.map((asset: { path: string }) => asset.path)).toEqual([assetName, `manifest-${target}.json`]);
      for (const asset of handoff.assets) {
        expect(fs.readFileSync(path.join(f.root, 'handoff', asset.checksum_path))).toStrictEqual(Buffer.from(`${asset.sha256}  ${asset.path}\n`));
      }
      expect(fs.existsSync(path.join(f.root, 'managed'))).toBe(false);
      expect(fs.readdirSync(path.join(f.root, 'installer')).sort()).toEqual(['assembly.json', 'product.json']);
      expect(fs.existsSync(path.join(f.root, 'handoff/tmp'))).toBe(false);
    });
    test('keeps unselected release targets outside native selection', (t) => {
      // Arrange
      const f = fixture(t);
      fs.appendFileSync(path.join(f.root, 'platform.yml'), '  - id: other-architecture\n    runner: ubuntu-24.04\n    target: aarch64-unknown-linux-musl\n');
      f.configure();
      // Act
      runSupplemental(f.options);
      runSupplemental(prepareAssembly(f));
      // Assert
      expect(fs.existsSync(path.join(f.root, 'handoff/supplemental-manifest.json'))).toBe(true);
    });
    test('rejects release id or target mismatches in both phases', (t) => {
      // Arrange
      const cases = [{ platform_id: 'wrong-release' }, { platform_target: 'unsupported-target' }];
      for (const changes of cases) {
        const f = fixture(t);
        const buildPath = path.join(f.root, 'standard/asset-manifest.json');
        const build = JSON.parse(fs.readFileSync(buildPath, 'utf8'));
        fs.writeFileSync(buildPath, JSON.stringify({ ...build, ...changes }));
        // Act / Assert
        expect(() => runSupplemental(f.options)).toThrow('standard-installer-failed');
        expect(fs.existsSync(path.join(f.root, 'platform-output/platform-record.json'))).toBe(false);
        fs.writeFileSync(buildPath, JSON.stringify(build));
        fs.rmdirSync(path.join(f.root, 'platform-output'));
        runSupplemental(f.options);
        const assembled = prepareAssembly(f);
        fs.writeFileSync(path.join(f.root, assembled.standardBuildRoot, `release-build-${platform.id}`, 'asset-manifest.json'), JSON.stringify({ ...build, ...changes }));
        expect(() => runSupplemental(assembled)).toThrow('standard-installer-failed');
        expect(fs.existsSync(path.join(f.root, 'handoff/supplemental-manifest.json'))).toBe(false);
      }
    });
    test('rejects noncanonical checksum bytes in both phases', (t) => {
      // Arrange
      const f = fixture(t);
      const checksumPath = path.join(f.root, 'standard', `${archiveName}.sha256`);
      const expected = fs.readFileSync(checksumPath, 'utf8');
      const malformed = [expected.replace(/\n$/, '\r\n'), `\uFEFF${expected}`, expected.trimEnd(), `${expected}\n`, expected.replace(/\n$/, '\0\n'), expected.replace(/^[a-f0-9]{64}/, '0'.repeat(64))];
      for (const bytes of malformed) {
        fs.writeFileSync(checksumPath, bytes);
        // Act / Assert
        expect(() => runSupplemental(f.options)).toThrow('standard-installer-failed');
        expect(fs.existsSync(path.join(f.root, 'platform-output/platform-record.json'))).toBe(false);
        fs.rmdirSync(path.join(f.root, 'platform-output'));
      }
      fs.writeFileSync(checksumPath, expected);
      runSupplemental(f.options);
      const assembled = prepareAssembly(f);
      const transportedChecksum = path.join(f.root, assembled.standardBuildRoot, `release-build-${platform.id}`, `${archiveName}.sha256`);
      for (const bytes of malformed) {
        fs.writeFileSync(transportedChecksum, bytes);
        // Act / Assert
        expect(() => runSupplemental(assembled)).toThrow('standard-installer-failed');
        expect(fs.existsSync(path.join(f.root, 'handoff/supplemental-manifest.json'))).toBe(false);
        fs.rmdirSync(path.join(f.root, 'handoff'));
      }
    });
    test('rejects platform authority drift before execution', (t) => {
      // Arrange
      const f = fixture(t);
      fs.appendFileSync(path.join(f.root, 'platform.yml'), '\n');
      // Act
      const attempt = (): void => runSupplemental(f.options);
      // Assert
      expect(attempt).toThrow('platform-mismatch');
      expect(fs.existsSync(path.join(f.root, 'platform-output'))).toBe(false);
    });
    test('rejects platform mutation during provider execution', (t) => {
      // Arrange
      const f = fixture(t);
      const installerRoot = path.join(f.root, 'injected-provider');
      fs.mkdirSync(path.join(installerRoot, 'src'), { recursive: true });
      fs.writeFileSync(path.join(installerRoot, 'src/assembly.py'), 'import json,pathlib,sys\nr=json.load(sys.stdin)\np=pathlib.Path(r["sourceRoot"])/r["authority"]["platform_manifest"]\np.write_bytes(p.read_bytes()+b"\\n")\no=pathlib.Path(r["outputDirectory"])\no.mkdir()\n(o/"result").write_text("injected")\n');
      // Act
      const attempt = (): void => runSupplemental({ ...f.options, installerRoot });
      // Assert
      expect(attempt).toThrow('platform-mismatch');
      expect(fs.existsSync(path.join(f.root, 'platform-output/supplemental-manifest.json'))).toBe(false);
    });
    test('rejects changed product declaration before generating output', (t) => {
      // Arrange
      const f = fixture(t);
      fs.appendFileSync(path.join(f.root, 'installer/product.json'), ' ');
      // Act
      const attempt = (): void => runSupplemental(f.options);
      // Assert
      expect(attempt).toThrow('installer-declaration-source-mismatch');
      expect(fs.existsSync(path.join(f.root, 'platform-output'))).toBe(false);
    });
    test('rejects modified candidate even if supplied file hashes match', (t) => {
      // Arrange
      const f = fixture(t);
      runSupplemental(f.options);
      const options = prepareAssembly(f);
      const directory = path.join(f.root, `supplemental-download/supplemental-build-${platform.id}`);
      const candidate = path.join(directory, 'candidate', assetName);
      fs.appendFileSync(candidate, '\n# tampered\n');
      const recordPath = path.join(directory, 'platform-record.json');
      const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
      record.files[assetName] = sha256(fs.readFileSync(candidate));
      fs.writeFileSync(recordPath, JSON.stringify(record));
      // Act
      const attempt = (): void => runSupplemental(options);
      // Assert
      expect(attempt).toThrow('standard-installer-failed');
      expect(fs.existsSync(path.join(f.root, 'handoff/supplemental-manifest.json'))).toBe(false);
    });
    test('executes packaged local CLI with the same fixed boundary', (t) => {
      // Arrange
      const f = fixture(t);
      const args = Object.entries({ operation: 'build-platform', 'source-root': f.root, 'authority-path': 'authority.json', 'snapshot-path': 'snapshot.json', 'standard-build-root': 'standard', 'output-directory': 'platform-output', 'provider-revision': 'a'.repeat(40) }).flatMap(([key, value]) => [`--${key}`, value]);
      // Act
      const result = spawnSync(process.execPath, [path.join(repository, 'runtime/installer/run-installer.mjs'), ...args], { encoding: 'utf8' });
      // Assert
      expect(result.status, result.stderr).toBe(0);
      expect(fs.existsSync(path.join(f.root, 'platform-output/platform-record.json'))).toBe(true);
    });
    test('executes standard mode from the distributed Action and reports verified output', (t) => {
      // Arrange
      const f = fixture(t);
      // Act
      const { result, output } = runDistributedAction(f);
      // Assert
      expect(result.status, result.stderr).toBe(0);
      expect(fs.readFileSync(output, 'utf8')).toContain('status=success');
      expect(fs.readFileSync(output, 'utf8')).toContain('output-directory=platform-output');
      expect(fs.existsSync(path.join(f.root, 'platform-output/candidate/installer-asset-evidence.json'))).toBe(true);
    });
    test('rejects unsupported provider profile without successful Action output or generated assets', (t) => {
      // Arrange
      const f = fixture(t, 'unsupported');
      // Act
      const { result, output } = runDistributedAction(f);
      // Assert
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('standard-installer-failed');
      expect(fs.readFileSync(output, 'utf8')).toBe('');
      expect(fs.existsSync(path.join(f.root, 'platform-output'))).toBe(false);
    });
  });
  describe('selection', () => {
    test('rejects incompatible selections and malformed CLI arguments', () => {
      // Arrange
      const standard = { CI_SUPPLEMENTAL_RELEASE_ASSET_IMPLEMENTATION: 'standard-installer', CI_SUPPLEMENTAL_RELEASE_ASSET_ENABLED: 'true', CI_SUPPLEMENTAL_RELEASE_ASSET_OWNER_CONTRACT: 'installer.asset-assembly-evidence-contract' };
      const selections = [{ CI_SUPPLEMENTAL_RELEASE_ASSET_IMPLEMENTATION: 'unknown' }, { CI_SUPPLEMENTAL_RELEASE_ASSET_CONFIG_PATH: 'installer/product.json' }, { CI_SUPPLEMENTAL_RELEASE_ASSET_IMPLEMENTATION: 'standard-installer' }, { ...standard, CI_SUPPLEMENTAL_RELEASE_ASSET_OWNER_CONTRACT: 'other.contract' }, { ...standard, CI_SUPPLEMENTAL_RELEASE_ASSET_CONFIG_PATH: 42 }, { ...standard, CI_SUPPLEMENTAL_RELEASE_ASSET_CONFIG_PATH: 'bad\npath' }];
      // Act
      const attempts = selections.map((values) => (): unknown => supplementalSelection(values));
      // Assert
      for (const attempt of attempts) expect(attempt).toThrow();
      expect(() => runInstallerCli(['--unknown', 'value'], repository)).toThrow('installer-arguments-invalid');
      expect(() => runInstallerCli([], repository)).toThrow('installer-arguments-missing');
      for (const args of [['operation', 'assemble'], ['--operation'], ['--operation', '--assemble'], ['--operation', 'assemble', '--operation', 'assemble']]) expect(() => runInstallerCli(args, repository)).toThrow('installer-arguments-invalid');
      expect(supplementalSelection({ CI_SUPPLEMENTAL_RELEASE_ASSET_CONFIG_PATH: '' })).toEqual({ implementation: 'owner-adapter' });
    });
  });
});
