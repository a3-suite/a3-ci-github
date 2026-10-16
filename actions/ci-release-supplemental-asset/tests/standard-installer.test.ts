import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import { holdProcessOutput } from '../../../tests/support/hold-process-output.mjs';
import { runSupplemental } from '../../../runtime/release-publication/supplemental';
import { supplementalSelection } from '../../../runtime/release-publication/selection';
import { sha256 } from '../../../runtime/release-publication/io';
import { assembleRelease } from '../../../runtime/release-publication/assembly';
import { decodePlatformManifest } from '../../ci-release-assembly/src/platform-manifest-decoder';
import { validateHandoffIntegrity } from '../../ci-handoff-integrity/src/integrity';
import { runInstallerCli } from '../../../runtime/installer/cli';
import { archiveName, assetName, checkoutLineEndings, fixture, platform, prepareAssembly, python, repository, target } from './standard-installer-fixtures';

holdProcessOutput('stderr');

describe('standard installer', () => {
  // evidence_role: contract
  // flow_id: standard-installer-provider-execution
  // test_level: e2e
  describe('assembly', () => {
    for (const endings of ['lf', 'crlf', 'mixed']) test(`accepts ${endings} checkout declarations through both phases and release assembly`, (t) => {
      // Arrange
      const f = fixture(t);
      checkoutLineEndings(f.root, endings);
      // Act
      runSupplemental(f.options);
      const assembled = prepareAssembly(f);
      // The assembly job retains a control manifest outside the fixed product checkout.
      const source = path.join(f.root, 'release-source');
      fs.mkdirSync(source);
      fs.copyFileSync(path.join(f.root, 'platform.yml'), path.join(f.root, 'control-platform.yml'));
      for (const item of ['.git', 'installer', 'platform.yml', 'authority.json', 'snapshot.json', assembled.standardBuildRoot, assembled.supplementalBuildRoot!]) {
        fs.renameSync(path.join(f.root, item), path.join(source, item));
      }
      runSupplemental({ ...assembled, sourceRoot: source });
      const result = assembleRelease({ authorityPath: path.join(source, 'authority.json'), repository: 'fixture/tool', snapshotPath: path.join(source, 'snapshot.json'), platformManifestPath: path.join(f.root, 'control-platform.yml'), platformMatrix: JSON.stringify({ include: [platform] }), buildRoot: path.join(source, assembled.standardBuildRoot), supplementalRoot: path.join(source, 'handoff'), outputRoot: path.join(f.root, 'release-handoff') }, decodePlatformManifest);
      // Assert
      expect(result.assets.map((asset) => asset.name)).toContain(assetName);
    });
    test('rejects changes beyond checkout line endings in both phases', (t) => {
      // Arrange
      const changes = [
        (bytes: Buffer): Buffer => Buffer.concat([Buffer.from('\uFEFF'), bytes]),
        (bytes: Buffer): Buffer => Buffer.from(bytes.toString('utf8').replace(/\n/g, '\r')),
        (bytes: Buffer): Buffer => bytes.subarray(0, bytes.length - 1),
        (bytes: Buffer): Buffer => Buffer.concat([bytes, Buffer.from(' ')]),
        (bytes: Buffer): Buffer => Buffer.concat([bytes, Buffer.from([0xff])]),
        (bytes: Buffer): Buffer => Buffer.from(bytes.toString('utf8').replace(/("[^"]+": ")/, '$1changed-').replace(/^platforms:/, 'platforms: changed')),
      ];
      for (const relative of ['installer/assembly.json', 'installer/product.json', 'platform.yml']) {
        for (const [index, change] of changes.entries()) {
          for (const operation of ['build-platform', 'assemble']) {
            const f = fixture(t);
            let options = f.options;
            if (operation === 'assemble') { runSupplemental(f.options); options = prepareAssembly(f); }
            const filename = path.join(f.root, relative);
            const original = fs.readFileSync(filename);
            expect(change(original)).not.toEqual(original);
            fs.writeFileSync(filename, change(original));
            const code = index === 4 ? 'source-text-utf8-invalid' : relative === 'platform.yml' ? 'platform-mismatch'
              : relative === 'installer/assembly.json' ? 'owner-adapter-source-mismatch' : 'installer-declaration-source-mismatch';
            // Act / Assert
            expect(() => runSupplemental(options)).toThrow(code);
            expect(fs.existsSync(path.join(f.root, options.outputDirectory))).toBe(false);
          }
        }
      }
    });
    test('rejects newline-only input mutation during provider execution in both phases', (t) => {
      // Arrange
      for (const relative of ['installer/assembly.json', 'installer/product.json', 'platform.yml']) {
        for (const operation of ['build-platform', 'assemble']) {
          const f = fixture(t);
          let options = f.options;
          if (operation === 'assemble') { runSupplemental(f.options); options = prepareAssembly(f); }
          const installerRoot = path.join(f.root, 'injected-provider');
          fs.mkdirSync(path.join(installerRoot, 'src'), { recursive: true });
          fs.writeFileSync(path.join(installerRoot, 'src/assembly.py'), `import json,pathlib,sys\nr=json.load(sys.stdin)\np=pathlib.Path(r["sourceRoot"])/${JSON.stringify(relative)}\np.write_bytes(p.read_bytes().replace(b"\\n",b"\\r\\n"))\no=pathlib.Path(r["outputDirectory"])\no.mkdir()\n(o/"result").write_text("injected")\n`);
          // Act / Assert
          expect(() => runSupplemental({ ...options, installerRoot })).toThrow('build-input-mutated');
          expect(fs.existsSync(path.join(f.root, options.outputDirectory, 'supplemental-manifest.json'))).toBe(false);
        }
      }
    });
    test('verifies native candidate and produces handoff without consumer implementation', (t) => {
      // Arrange
      const f = fixture(t);
      // Act
      runInstallerCli(['--operation', 'build-platform', '--source-root', f.root, '--authority-path', 'authority.json', '--snapshot-path', 'snapshot.json', '--standard-build-root', 'standard', '--output-directory', 'platform-output', '--provider-revision', 'a'.repeat(40)], path.join(repository, 'runtime/installer/dist'));
      const assembled = prepareAssembly(f);
      if (process.env.CI_INSTALLER_PLATFORM_ACCEPTANCE_OUTPUT) {
        const output = path.resolve(repository, process.env.CI_INSTALLER_PLATFORM_ACCEPTANCE_OUTPUT);
        fs.mkdirSync(output, { recursive: true });
        fs.cpSync(path.join(f.root, 'supplemental-download'), path.join(output, 'supplemental-download'), { recursive: true });
        // Source objects and declarations are fixture context, separate from the artifact under test.
        execFileSync(python, ['-c', 'import pathlib,sys,zipfile\nroot=pathlib.Path(sys.argv[1])\nwith zipfile.ZipFile(sys.argv[2],"w") as archive:\n for name in [".git","installer","standard-download","platform.yml","authority.json","snapshot.json"]:\n  item=root/name\n  for file in (item.rglob("*") if item.is_dir() else [item]):\n   if file.is_file(): archive.write(file,file.relative_to(root).as_posix())', f.root, path.join(output, 'context.zip')]);
      }
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
    test('revalidates downloaded platform evidence', (t) => {
      let root: string;
      if (process.env.CI_INSTALLER_PLATFORM_INPUT) {
        fs.mkdirSync(path.join(repository, 'tests/tmp'), { recursive: true });
        root = fs.realpathSync(fs.mkdtempSync(path.join(repository, 'tests/tmp/installer-transport-')));
        t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
        const input = path.resolve(repository, process.env.CI_INSTALLER_PLATFORM_INPUT);
        execFileSync(python, ['-c', 'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as archive: archive.extractall(sys.argv[2])', path.join(input, 'context.zip'), root]);
        fs.mkdirSync(path.join(root, '.git/refs'), { recursive: true });
        fs.cpSync(path.join(input, 'supplemental-download'), path.join(root, 'supplemental-download'), { recursive: true });
      } else {
        const f = fixture(t);
        runSupplemental(f.options);
        prepareAssembly(f);
        root = f.root;
      }
      const candidates = path.join(root, 'supplemental-download');
      const platformRoot = path.join(candidates, fs.readdirSync(candidates)[0]);
      const record = JSON.parse(fs.readFileSync(path.join(platformRoot, 'platform-record.json'), 'utf8'));
      const candidate = path.join(platformRoot, 'candidate');
      expect(Object.keys(record.files)).toContain('.installer-source.zip');
      expect(fs.readdirSync(candidate).sort()).toEqual(Object.keys(record.files).sort());
      for (const [name, digest] of Object.entries(record.files)) expect(sha256(fs.readFileSync(path.join(candidate, name)))).toBe(digest);
      runInstallerCli(['--operation', 'assemble', '--source-root', root, '--authority-path', 'authority.json', '--snapshot-path', 'snapshot.json', '--standard-build-root', 'standard-download', '--supplemental-build-root', 'supplemental-download', '--output-directory', 'transport-handoff', '--provider-revision', 'a'.repeat(40)], path.join(repository, 'runtime/installer/dist'));
      const manifest = JSON.parse(fs.readFileSync(path.join(root, 'transport-handoff/supplemental-manifest.json'), 'utf8'));
      const declaration = JSON.parse(fs.readFileSync(path.join(root, 'installer/assembly.json'), 'utf8'));
      const declaredAssets = Object.entries(declaration.platforms).flatMap(([platformId, entry]) => [(entry as { assetName: string }).assetName, `manifest-${platformId}.json`]);
      expect(manifest.assets.map((asset: { path: string }) => asset.path).sort()).toEqual(declaredAssets.sort());
      expect(fs.readdirSync(path.join(root, 'transport-handoff')).some((name) => name.includes('installer-source'))).toBe(false);
    });
    for (const mutation of ['missing', 'modified', 'extra']) test(`rejects ${mutation} transferred platform evidence`, (t) => {
      const f = fixture(t);
      runSupplemental(f.options);
      const assembled = prepareAssembly(f);
      const platformRoot = path.join(f.root, assembled.supplementalBuildRoot!, `supplemental-build-${platform.id}`);
      const candidate = path.join(platformRoot, 'candidate');
      const source = path.join(candidate, '.installer-source.zip');
      if (mutation === 'missing') fs.unlinkSync(source);
      else if (mutation === 'modified') fs.appendFileSync(source, 'corruption');
      else fs.writeFileSync(path.join(candidate, '.undeclared'), 'unexpected');
      expect(() => runSupplemental(assembled)).toThrow('standard-installer-failed');
      expect(fs.existsSync(path.join(f.root, 'handoff/supplemental-manifest.json'))).toBe(false);
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
