import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import { holdProcessOutput } from '../../../tests/support/hold-process-output.mjs';
import { supplementalSelection } from '../../../runtime/release-publication/selection';
import { sha256 } from '../../../runtime/release-publication/io';
import { assembleRelease } from '../../../runtime/release-publication/assembly';
import { decodePlatformManifest } from '../../ci-release-assembly/src/platform-manifest-decoder';
import { validateHandoffIntegrity } from '../../ci-handoff-integrity/src/integrity';
import { runInstallerCli } from '../../../runtime/installer/cli';
import { archiveName, assetName, checkoutLineEndings, fixture, platform, prepareAssembly, python, repository, rejectSupplementalAction, runSupplementalAction, target } from './standard-installer-fixtures';

holdProcessOutput('stderr');

// The failure result output is the runner output file that the harness hands to the Action (`runner-output`); it is excluded from the comparison.
const fileNames = (directory: string): string[] => fs.readdirSync(directory, { recursive: true, encoding: 'utf8' }).filter((name) => name !== 'runner-output').sort();

const transportTimeout = 30_000;

const acceptancePath = (value: string): string => {
  if (path.isAbsolute(value) || path.win32.isAbsolute(value) || value.split(/[\\/]/).includes('..')) {
    throw new Error('Installer acceptance paths must be repository-relative');
  }
  const root = fs.realpathSync(repository);
  const resolved = path.resolve(root, value);
  let ancestor = resolved;
  while (true) {
    try { fs.lstatSync(ancestor); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      ancestor = path.dirname(ancestor);
    }
  }
  const relative = path.relative(root, fs.realpathSync(ancestor));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Installer acceptance paths must stay inside the repository');
  }
  return resolved;
};

// Source objects and declarations are fixture context, separate from the artifact under test.
const packTransport = (root: string, output: string) => {
  fs.mkdirSync(output, { recursive: true });
  fs.cpSync(path.join(root, 'supplemental-download'), path.join(output, 'supplemental-download'), { recursive: true });
  execFileSync(python, ['-c', 'import pathlib,sys,zipfile\nroot=pathlib.Path(sys.argv[1])\nwith zipfile.ZipFile(sys.argv[2],"w") as archive:\n for name in [".git",".ci","standard-download","platform.yml","authority.json","snapshot.json"]:\n  item=root/name\n  for file in (item.rglob("*") if item.is_dir() else [item]):\n   if file.is_file(): archive.write(file,file.relative_to(root).as_posix())', root, path.join(output, 'context.zip')], { timeout: transportTimeout });
};
const unpackTransport = (input: string, root: string) => {
  execFileSync(python, ['-c', 'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as archive: archive.extractall(sys.argv[2])', path.join(input, 'context.zip'), root], { timeout: transportTimeout });
  fs.mkdirSync(path.join(root, '.git/refs'), { recursive: true });
  fs.cpSync(path.join(input, 'supplemental-download'), path.join(root, 'supplemental-download'), { recursive: true });
};

describe('standard installer', () => {
  // evidence_role: contract
  // flow_id: standard-installer-provider-execution
  // test_level: e2e
  describe('assembly', () => {
    // evidence_role: supplemental
    // Also checks that release assembly accepts the result, which belongs to the ci-release-assembly contract; the distributed CRLF test covers both phases.
    for (const endings of ['lf', 'crlf', 'mixed']) test(`accepts ${endings} checkout declarations through both phases and release assembly`, (t) => {
      // Arrange
      const f = fixture(t);
      checkoutLineEndings(f.root, endings);
      // Act
      runSupplementalAction(f.options);
      const assembled = prepareAssembly(f);
      // The assembly job retains a control manifest outside the fixed product checkout.
      const source = path.join(f.root, 'release-source');
      fs.mkdirSync(source);
      fs.copyFileSync(path.join(f.root, 'platform.yml'), path.join(f.root, 'control-platform.yml'));
      for (const item of ['.git', '.ci', 'platform.yml', 'authority.json', 'snapshot.json', assembled.standardBuildRoot, assembled.supplementalBuildRoot!]) {
        fs.renameSync(path.join(f.root, item), path.join(source, item));
      }
      runSupplementalAction({ ...assembled, sourceRoot: source });
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
      for (const relative of ['.ci/installer/assembly.json', '.ci/installer/product.json', 'platform.yml']) {
        for (const [index, change] of changes.entries()) {
          for (const operation of ['build-platform', 'assemble']) {
            const f = fixture(t);
            let options = f.options;
            if (operation === 'assemble') { runSupplementalAction(f.options); options = prepareAssembly(f); }
            const filename = path.join(f.root, relative);
            const original = fs.readFileSync(filename);
            expect(change(original)).not.toEqual(original);
            fs.writeFileSync(filename, change(original));
            const code = index === 4 ? 'source-text-utf8-invalid' : relative === 'platform.yml' ? 'platform-mismatch'
              : relative === '.ci/installer/assembly.json' ? 'owner-adapter-source-mismatch' : 'installer-declaration-source-mismatch';
            const filesBefore = fileNames(f.root);
            // Act / Assert
            rejectSupplementalAction(options, code);
            expect(fs.existsSync(path.join(f.root, options.outputDirectory))).toBe(false);
            expect(fileNames(f.root)).toEqual(filesBefore);
          }
        }
      }
    });
    const rejectNewlineMutation = (t: Parameters<typeof fixture>[0], mode: 'rejection' | 'files'): void => {
      // Arrange
      for (const relative of ['.ci/installer/assembly.json', '.ci/installer/product.json', 'platform.yml']) {
        for (const operation of ['build-platform', 'assemble']) {
          const f = fixture(t);
          let options = f.options;
          if (operation === 'assemble') { runSupplementalAction(f.options); options = prepareAssembly(f); }
          const installerRoot = path.join(f.root, 'injected-provider');
          fs.mkdirSync(path.join(installerRoot, 'src'), { recursive: true });
          fs.writeFileSync(path.join(installerRoot, 'src/assembly.py'), `import json,pathlib,sys\nr=json.load(sys.stdin)\np=pathlib.Path(r["sourceRoot"])/${JSON.stringify(relative)}\np.write_bytes(p.read_bytes().replace(b"\\n",b"\\r\\n"))\no=pathlib.Path(r["outputDirectory"])\no.mkdir()\n(o/"result").write_text("injected")\n`);
          // Act / Assert
          rejectSupplementalAction(options, 'build-input-mutated', installerRoot);
          if (mode === 'files') expect(fs.existsSync(path.join(f.root, options.outputDirectory, 'supplemental-manifest.json'))).toBe(false);
        }
      }
    };
    test('rejects newline-only input mutation during provider execution in both phases', (t) => rejectNewlineMutation(t, 'rejection'));
    // evidence_role: supplemental
    // A rejection after the provider has run may leave partial output, so the absent manifest is not an observation of the existing-state guarantees.
    test('writes no supplemental manifest when newline-only input mutation during provider execution is rejected', (t) => rejectNewlineMutation(t, 'files'));
    // contract_id: contract.ci-release-supplemental-asset.assembly
    // flow_id: standard-installer-candidate-assembly
    test('verifies native candidate and produces handoff without consumer implementation', (t) => {
      // Arrange
      const f = fixture(t);
      // Act
      runSupplementalAction(f.options);
      const assembled = prepareAssembly(f);
      if (process.env.CI_INSTALLER_PLATFORM_ACCEPTANCE_OUTPUT) packTransport(f.root, acceptancePath(process.env.CI_INSTALLER_PLATFORM_ACCEPTANCE_OUTPUT));
      runSupplementalAction(assembled);
      const releaseRoot = path.join(f.root, 'release-handoff');
      const release = assembleRelease({ authorityPath: path.join(f.root, 'authority.json'), repository: 'fixture/tool', snapshotPath: path.join(f.root, 'snapshot.json'), platformManifestPath: path.join(f.root, 'platform.yml'), platformMatrix: JSON.stringify({ include: [platform] }), buildRoot: path.join(f.root, assembled.standardBuildRoot), supplementalRoot: path.join(f.root, 'handoff'), outputRoot: releaseRoot }, decodePlatformManifest);
      const expected = { sourceSha: release.identity.source_sha, version: release.identity.version, targetIdentity: release.identity.target_identity };
      if (process.env.CI_INSTALLER_ACCEPTANCE_OUTPUT) {
        fs.cpSync(releaseRoot, acceptancePath(process.env.CI_INSTALLER_ACCEPTANCE_OUTPUT), { recursive: true });
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
      expect(fs.readdirSync(path.join(f.root, '.ci/installer')).sort()).toEqual(['assembly.json', 'product.json']);
    });
    // evidence_role: supplemental
    // Leaving no managed directory or temporary handoff directory is a filesystem side effect of assembly that no contract guarantee covers.
    test('assembly leaves no managed directory or temporary handoff directory', (t) => {
      // Arrange
      const f = fixture(t);
      runSupplementalAction(f.options);
      const assembled = prepareAssembly(f);
      // Act
      runSupplementalAction(assembled);
      // Assert
      expect(fs.existsSync(path.join(f.root, 'managed'))).toBe(false);
      expect(fs.existsSync(path.join(f.root, 'handoff/tmp'))).toBe(false);
    });
    // contract_id: contract.ci-release-supplemental-asset.assembly
    // flow_id: standard-installer-candidate-assembly
    test('revalidates downloaded platform evidence', (t) => {
      let input: string;
      if (process.env.CI_INSTALLER_PLATFORM_INPUT) input = acceptancePath(process.env.CI_INSTALLER_PLATFORM_INPUT);
      else {
        // Without a producer job, pack the local fixture the same way so the transport contents stay verified.
        const f = fixture(t);
        runSupplementalAction(f.options);
        prepareAssembly(f);
        input = path.join(f.root, 'platform-transport');
        packTransport(f.root, input);
      }
      fs.mkdirSync(path.join(repository, 'tests/tmp'), { recursive: true });
      const root = fs.realpathSync(fs.mkdtempSync(path.join(repository, 'tests/tmp/installer-transport-')));
      t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
      unpackTransport(input, root);
      const candidates = path.join(root, 'supplemental-download');
      const platformRoot = path.join(candidates, fs.readdirSync(candidates)[0]);
      const record = JSON.parse(fs.readFileSync(path.join(platformRoot, 'platform-record.json'), 'utf8'));
      const candidate = path.join(platformRoot, 'candidate');
      expect(Object.keys(record.files)).toContain('.installer-source.zip');
      const declarationFiles = fs.readdirSync(path.join(root, '.ci/installer')).sort();
      runSupplementalAction({ operation: 'assemble', sourceRoot: root, authorityPath: 'authority.json', snapshotPath: 'snapshot.json', standardBuildRoot: 'standard-download', supplementalBuildRoot: 'supplemental-download', outputDirectory: 'transport-handoff', installerRoot: path.join(repository, 'runtime/installer'), providerRevision: 'a'.repeat(40) });
      expect(fs.readdirSync(candidate).sort()).toEqual(Object.keys(record.files).sort());
      for (const [name, digest] of Object.entries(record.files)) expect(sha256(fs.readFileSync(path.join(candidate, name)))).toBe(digest);
      const manifest = JSON.parse(fs.readFileSync(path.join(root, 'transport-handoff/supplemental-manifest.json'), 'utf8'));
      const declaration = JSON.parse(fs.readFileSync(path.join(root, '.ci/installer/assembly.json'), 'utf8'));
      const declaredAssets = Object.entries(declaration.platforms).flatMap(([platformId, entry]) => [(entry as { assetName: string }).assetName, `manifest-${platformId}.json`]);
      expect(manifest.assets.map((asset: { path: string }) => asset.path).sort()).toEqual(declaredAssets.sort());
      expect(fs.readdirSync(path.join(root, 'transport-handoff')).some((name) => name.includes('installer-source'))).toBe(false);
      for (const asset of manifest.assets) {
        expect(fs.readFileSync(path.join(root, 'transport-handoff', asset.checksum_path))).toStrictEqual(Buffer.from(`${asset.sha256}  ${asset.path}\n`));
      }
      expect(fs.readdirSync(path.join(root, '.ci/installer')).sort()).toEqual(declarationFiles);
    });
    const rejectTransferredEvidence = (t: Parameters<typeof fixture>[0], mutation: string, mode: 'rejection' | 'files'): void => {
      const f = fixture(t);
      runSupplementalAction(f.options);
      const assembled = prepareAssembly(f);
      const platformRoot = path.join(f.root, assembled.supplementalBuildRoot!, `supplemental-build-${platform.id}`);
      const candidate = path.join(platformRoot, 'candidate');
      const source = path.join(candidate, '.installer-source.zip');
      if (mutation === 'missing') fs.unlinkSync(source);
      else if (mutation === 'modified') fs.appendFileSync(source, 'corruption');
      else fs.writeFileSync(path.join(candidate, '.undeclared'), 'unexpected');
      rejectSupplementalAction(assembled, 'standard-installer-failed');
      if (mode === 'files') expect(fs.existsSync(path.join(f.root, 'handoff/supplemental-manifest.json'))).toBe(false);
    };
    for (const mutation of ['missing', 'modified', 'extra']) test(`rejects ${mutation} transferred platform evidence`, (t) => rejectTransferredEvidence(t, mutation, 'rejection'));
    // evidence_role: supplemental
    // A rejected transfer may leave partial output, so the absent manifest is not an observation of the existing-state guarantees.
    for (const mutation of ['missing', 'modified', 'extra']) test(`writes no supplemental manifest when ${mutation} transferred platform evidence is rejected`, (t) => rejectTransferredEvidence(t, mutation, 'files'));
    test('keeps unselected release targets outside native selection', (t) => {
      // Arrange
      const f = fixture(t);
      fs.appendFileSync(path.join(f.root, 'platform.yml'), '  - id: other-architecture\n    runner: ubuntu-24.04\n    target: aarch64-unknown-linux-musl\n');
      f.configure();
      // Act
      runSupplementalAction(f.options);
      runSupplementalAction(prepareAssembly(f));
      // Assert
      expect(fs.existsSync(path.join(f.root, 'handoff/supplemental-manifest.json'))).toBe(true);
    });
    const rejectReleaseMismatches = (t: Parameters<typeof fixture>[0], mode: 'rejection' | 'files'): void => {
      // Arrange
      const cases = [{ platform_id: 'wrong-release' }, { platform_target: 'unsupported-target' }];
      for (const changes of cases) {
        const f = fixture(t);
        const buildPath = path.join(f.root, 'standard/asset-manifest.json');
        const build = JSON.parse(fs.readFileSync(buildPath, 'utf8'));
        fs.writeFileSync(buildPath, JSON.stringify({ ...build, ...changes }));
        // Act / Assert
        rejectSupplementalAction(f.options, 'standard-installer-failed');
        if (mode === 'files') expect(fs.existsSync(path.join(f.root, 'platform-output/platform-record.json'))).toBe(false);
        fs.writeFileSync(buildPath, JSON.stringify(build));
        fs.rmdirSync(path.join(f.root, 'platform-output'));
        runSupplementalAction(f.options);
        const assembled = prepareAssembly(f);
        fs.writeFileSync(path.join(f.root, assembled.standardBuildRoot, `release-build-${platform.id}`, 'asset-manifest.json'), JSON.stringify({ ...build, ...changes }));
        rejectSupplementalAction(assembled, 'standard-installer-failed');
        if (mode === 'files') expect(fs.existsSync(path.join(f.root, 'handoff/supplemental-manifest.json'))).toBe(false);
      }
    };
    test('rejects release id or target mismatches in both phases', (t) => rejectReleaseMismatches(t, 'rejection'));
    // evidence_role: supplemental
    // A rejection that comes after the output directory is created may leave partial output, so the absent record or manifest is not an observation of the existing-state guarantees.
    test('writes no platform record or supplemental manifest when release id or target mismatches are rejected', (t) => rejectReleaseMismatches(t, 'files'));
    const rejectNoncanonicalChecksums = (t: Parameters<typeof fixture>[0], mode: 'rejection' | 'files'): void => {
      // Arrange
      const f = fixture(t);
      const checksumPath = path.join(f.root, 'standard', `${archiveName}.sha256`);
      const expected = fs.readFileSync(checksumPath, 'utf8');
      const malformed = [expected.replace(/\n$/, '\r\n'), `\uFEFF${expected}`, expected.trimEnd(), `${expected}\n`, expected.replace(/\n$/, '\0\n'), expected.replace(/^[a-f0-9]{64}/, '0'.repeat(64))];
      for (const bytes of malformed) {
        fs.writeFileSync(checksumPath, bytes);
        // Act / Assert
        rejectSupplementalAction(f.options, 'standard-installer-failed');
        if (mode === 'files') expect(fs.existsSync(path.join(f.root, 'platform-output/platform-record.json'))).toBe(false);
        fs.rmdirSync(path.join(f.root, 'platform-output'));
      }
      fs.writeFileSync(checksumPath, expected);
      runSupplementalAction(f.options);
      const assembled = prepareAssembly(f);
      const transportedChecksum = path.join(f.root, assembled.standardBuildRoot, `release-build-${platform.id}`, `${archiveName}.sha256`);
      for (const bytes of malformed) {
        fs.writeFileSync(transportedChecksum, bytes);
        // Act / Assert
        rejectSupplementalAction(assembled, 'standard-installer-failed');
        if (mode === 'files') expect(fs.existsSync(path.join(f.root, 'handoff/supplemental-manifest.json'))).toBe(false);
        fs.rmdirSync(path.join(f.root, 'handoff'));
      }
    };
    test('rejects noncanonical checksum bytes in both phases', (t) => rejectNoncanonicalChecksums(t, 'rejection'));
    // evidence_role: supplemental
    // A rejection that comes after the output directory is created may leave partial output, so the absent record or manifest is not an observation of the existing-state guarantees.
    test('writes no platform record or supplemental manifest when noncanonical checksum bytes are rejected', (t) => rejectNoncanonicalChecksums(t, 'files'));
    test('rejects platform authority drift before execution', (t) => {
      // Arrange
      const f = fixture(t);
      fs.appendFileSync(path.join(f.root, 'platform.yml'), '\n');
      const filesBefore = fileNames(f.root);
      // Act
      rejectSupplementalAction(f.options, 'platform-mismatch');
      // Assert
      expect(fs.existsSync(path.join(f.root, 'platform-output'))).toBe(false);
      expect(fileNames(f.root)).toEqual(filesBefore);
    });
    const rejectPlatformMutation = (t: Parameters<typeof fixture>[0], mode: 'rejection' | 'files'): void => {
      // Arrange
      const f = fixture(t);
      const installerRoot = path.join(f.root, 'injected-provider');
      fs.mkdirSync(path.join(installerRoot, 'src'), { recursive: true });
      fs.writeFileSync(path.join(installerRoot, 'src/assembly.py'), 'import json,pathlib,sys\nr=json.load(sys.stdin)\np=pathlib.Path(r["sourceRoot"])/r["authority"]["platform_manifest"]\np.write_bytes(p.read_bytes()+b"\\n")\no=pathlib.Path(r["outputDirectory"])\no.mkdir()\n(o/"result").write_text("injected")\n');
      // Act
      rejectSupplementalAction(f.options, 'platform-mismatch', installerRoot);
      // Assert
      if (mode === 'files') expect(fs.existsSync(path.join(f.root, 'platform-output/platform-record.json'))).toBe(false);
    };
    test('rejects platform mutation during provider execution', (t) => rejectPlatformMutation(t, 'rejection'));
    // evidence_role: supplemental
    // A rejection after the provider has run may leave partial output, so the absent record is not an observation of the existing-state guarantees.
    test('writes no platform record when platform mutation during provider execution is rejected', (t) => rejectPlatformMutation(t, 'files'));
    test('rejects changed product declaration before generating output', (t) => {
      // Arrange
      const f = fixture(t);
      fs.appendFileSync(path.join(f.root, '.ci/installer/product.json'), ' ');
      const filesBefore = fileNames(f.root);
      // Act
      rejectSupplementalAction(f.options, 'installer-declaration-source-mismatch');
      // Assert
      expect(fs.existsSync(path.join(f.root, 'platform-output'))).toBe(false);
      expect(fileNames(f.root)).toEqual(filesBefore);
    });
    const rejectModifiedCandidate = (t: Parameters<typeof fixture>[0], mode: 'rejection' | 'files'): void => {
      // Arrange
      const f = fixture(t);
      runSupplementalAction(f.options);
      const options = prepareAssembly(f);
      const directory = path.join(f.root, `supplemental-download/supplemental-build-${platform.id}`);
      const candidate = path.join(directory, 'candidate', assetName);
      fs.appendFileSync(candidate, '\n# tampered\n');
      const recordPath = path.join(directory, 'platform-record.json');
      const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
      record.files[assetName] = sha256(fs.readFileSync(candidate));
      fs.writeFileSync(recordPath, JSON.stringify(record));
      // Act
      rejectSupplementalAction(options, 'standard-installer-failed');
      // Assert
      if (mode === 'files') expect(fs.existsSync(path.join(f.root, 'handoff/supplemental-manifest.json'))).toBe(false);
    };
    test('rejects modified candidate even if supplied file hashes match', (t) => rejectModifiedCandidate(t, 'rejection'));
    // evidence_role: supplemental
    // A rejection that comes after the output directory is created may leave partial output, so the absent record or manifest is not an observation of the existing-state guarantees.
    test('writes no supplemental manifest when a modified candidate is rejected', (t) => rejectModifiedCandidate(t, 'files'));
  });
  describe('selection', () => {
    test('rejects incompatible selections and malformed CLI arguments', () => {
      // Arrange
      const standard = { CI_SUPPLEMENTAL_RELEASE_ASSET_IMPLEMENTATION: 'standard-installer', CI_SUPPLEMENTAL_RELEASE_ASSET_ENABLED: 'true', CI_SUPPLEMENTAL_RELEASE_ASSET_OWNER_CONTRACT: 'installer.asset-assembly-evidence-contract' };
      const selections = [{ CI_SUPPLEMENTAL_RELEASE_ASSET_IMPLEMENTATION: 'unknown' }, { CI_SUPPLEMENTAL_RELEASE_ASSET_CONFIG_PATH: '.ci/installer/product.json' }, { CI_SUPPLEMENTAL_RELEASE_ASSET_IMPLEMENTATION: 'standard-installer' }, { ...standard, CI_SUPPLEMENTAL_RELEASE_ASSET_OWNER_CONTRACT: 'other.contract' }, { ...standard, CI_SUPPLEMENTAL_RELEASE_ASSET_CONFIG_PATH: 42 }, { ...standard, CI_SUPPLEMENTAL_RELEASE_ASSET_CONFIG_PATH: 'bad\npath' }];
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
