import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { expect, type TestContext } from 'vitest';
import type { SupplementalOptionsType } from '../../../runtime/release-publication/supplemental';
import { canonicalJson, sha256 } from '../../../runtime/release-publication/io';

const repository = path.resolve(__dirname, '../../..');
export const python = process.platform === 'win32' ? 'python' : 'python3';
const target = process.platform === 'win32' ? 'windows-x86_64' : process.platform === 'darwin' ? 'macos-arm64' : 'linux-x86_64';
const platform = { id: `release-${process.platform}`, runner: process.platform === 'win32' ? 'windows-2022' : process.platform === 'darwin' ? 'macos-14' : 'ubuntu-24.04', target: process.platform === 'win32' ? 'x86_64-pc-windows-msvc' : process.platform === 'darwin' ? 'aarch64-apple-darwin' : 'x86_64-unknown-linux-gnu' };
const archiveName = process.platform === 'win32' ? 'tool.zip' : 'tool.tar.gz';
const assetName = process.platform === 'win32' ? 'install.ps1' : `install-${target}.sh`;

export { archiveName, assetName, platform, repository, target };
export type { SupplementalOptionsType };

export const fixture = (t: TestContext, verificationProfile = 'native-offline-dry-run-v1', windowsAssetName?: string): { root: string; options: SupplementalOptionsType; configure: (changes?: Record<string, string>) => void } => {
  const parent = path.join(repository, 'tests/tmp');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(parent, 'standard-installer-')));
  t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = JSON.parse(fs.readFileSync(path.join(repository, 'skills/ci-release-installer/assets/examples/native-manifest.template.json'), 'utf8'));
  const managed = path.join(root, 'managed');
  manifest.placement = { managedRoot: managed, releasePath: path.join(managed, 'releases/1.0.0'), currentLink: path.join(managed, 'current') };
  manifest.activation = { strategy: 'active-pointer' };
  manifest.concurrency = { lockPath: path.join(managed, 'install.lock') };
  manifest.state = { installStatePath: path.join(managed, 'state/install.state') };
  manifest.compatibility = { requiredInstallerVersion: '2' };
  fs.mkdirSync(path.join(root, 'installer'));
  fs.writeFileSync(path.join(root, 'installer/product.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const platforms = { [target]: { manifest: 'installer/product.json', assetName }, ...(windowsAssetName === undefined ? {} : { 'windows-x86_64': { manifest: 'installer/product.json', assetName: windowsAssetName } }) };
  fs.writeFileSync(path.join(root, 'installer/assembly.json'), `${JSON.stringify({ schemaVersion: 'installer.assembly.v1', useCase: 'github-release-native', verificationProfile, platforms }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'platform.yml'), `platforms:\n  - id: ${platform.id}\n    runner: ${platform.runner}\n    target: ${platform.target}\n`);
  execFileSync('git', ['init', '-q', '--object-format=sha1', root]);
  execFileSync('git', ['-C', root, 'config', 'core.autocrlf', 'false']);
  execFileSync('git', ['-C', root, 'add', 'installer', 'platform.yml']);
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

export const prepareAssembly = (f: ReturnType<typeof fixture>): SupplementalOptionsType => {
  fs.mkdirSync(path.join(f.root, 'standard-download'));
  fs.renameSync(path.join(f.root, 'standard'), path.join(f.root, `standard-download/release-build-${platform.id}`));
  fs.mkdirSync(path.join(f.root, 'supplemental-download'));
  fs.renameSync(path.join(f.root, 'platform-output'), path.join(f.root, `supplemental-download/supplemental-build-${platform.id}`));
  return { ...f.options, operation: 'assemble', standardBuildRoot: 'standard-download', supplementalBuildRoot: 'supplemental-download', outputDirectory: 'handoff' };
};

export const checkoutLineEndings = (root: string, endings: string): void => {
  const files = ['installer/assembly.json', 'installer/product.json', 'platform.yml'];
  for (const relative of files) fs.unlinkSync(path.join(root, relative));
  execFileSync('git', ['-C', root, '-c', `core.autocrlf=${endings === 'lf' ? 'false' : 'true'}`, 'checkout-index', '--force', '--', ...files]);
  for (const relative of files) {
    const filename = path.join(root, relative);
    if (endings === 'mixed') {
      let line = 0;
      fs.writeFileSync(filename, fs.readFileSync(filename, 'utf8').replace(/\r\n/g, () => ++line % 2 ? '\n' : '\r\n'));
    }
    const bytes = fs.readFileSync(filename, 'utf8');
    if (endings !== 'lf') expect(bytes).toContain('\r\n');
    if (endings !== 'crlf') expect(bytes.replace(/\r\n/g, '')).toContain('\n');
  }
};

export const runDistributedAction = (f: ReturnType<typeof fixture>, options = f.options, entrypointArgs = [path.join(repository, 'actions/ci-release-supplemental-asset/dist/index.js')]) => {
  const output = path.join(f.root, 'runner-output');
  fs.writeFileSync(output, '');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output, A3_INSTALLER_PROVIDER_REVISION: 'a'.repeat(40), INPUT_OPERATION: options.operation, 'INPUT_SOURCE-ROOT': f.root, 'INPUT_AUTHORITY-PATH': 'authority.json', 'INPUT_SNAPSHOT-PATH': 'snapshot.json', 'INPUT_STANDARD-BUILD-ROOT': options.standardBuildRoot, 'INPUT_OUTPUT-DIRECTORY': options.outputDirectory, 'INPUT_SUPPLEMENTAL-BUILD-ROOT': options.supplementalBuildRoot ?? '' };
  const result = spawnSync(process.execPath, entrypointArgs, { cwd: f.root, encoding: 'utf8', env });
  return { result, output };
};
