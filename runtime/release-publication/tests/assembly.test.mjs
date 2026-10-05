import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, vi, describe, expect } from 'vitest';
import { fixture } from './fixtures.mjs';
import { sha256, canonicalJson } from '../io.ts';
import { validateEvidence } from '../schema.ts';
import { loadAssembly } from '../observation.ts';

const hasPwsh = spawnSync('pwsh', ['--version'], { encoding: 'utf8' }).status === 0;

describe("contract.ci-release-assembly.outputs", () => {
  describe("release-assembly-contract", () => {
    // contract_id: contract.ci-release-assembly.outputs
    // integration_id: release-assembly-contract
    test('assembly produces a bound handoff and rejects invalid build inputs', (t) => {
      const f = fixture(t);
      const result = f.assemble();
      expect(result.assets.length).toBe(2);
      expect(result.identity.source_sha).toBe(f.identity.source_sha);
      expect(loadAssembly({ ...f.options, handoffRoot: f.options.outputRoot }).assembly.asset_digest).toBe(result.asset_digest);
      expect(f.assemble).toThrow(/EEXIST/);
    });

    // contract_id: contract.ci-release-assembly.outputs
    // integration_id: release-assembly-contract
    test('asset digest preserves producer bytes and ignores JSON key order', (t) => {
      const f = fixture(t);
      const result = f.assemble();
      const originalDigest = sha256(Buffer.from(JSON.stringify(result.assets)));
      expect(result.asset_digest).toBe(originalDigest);
      const reordered = { ...result, assets: result.assets.map(({ name, sha256: digest, size }) => ({ size, sha256: digest, name })) };
      f.put('handoff/assembly.json', reordered);
      expect(loadAssembly({ ...f.options, handoffRoot: f.options.outputRoot }).assembly.asset_digest).toBe(originalDigest);
      for (const [field, value] of [['name', 'changed.tar.gz'], ['sha256', '0'.repeat(64)], ['size', result.assets[0].size + 1]]) {
        f.put('handoff/assembly.json', { ...result, assets: result.assets.map((asset, index) => index === 0 ? { ...asset, [field]: value } : asset) });
        expect(() => loadAssembly({ ...f.options, handoffRoot: f.options.outputRoot })).toThrow(/asset-set-mismatch/);
      }
    });

    // contract_id: contract.ci-release-assembly.outputs
    // integration_id: release-assembly-contract
    test('assembly accepts PowerShell package output and rejects altered checksum records', { skip: !hasPwsh }, (t) => {
      const platform = { id: 'windows-x64', runner: 'windows-2022', target: 'x86_64-pc-windows-msvc' };
      const f = fixture(t, platform);
      const output = path.join(f.options.buildRoot, `release-build-${platform.id}`);
      fs.rmSync(output, { recursive: true });
      const binary = f.put('project.exe', 'release-binary');
      const script = fileURLToPath(new URL('../../rust-release/package-release.ps1', import.meta.url));

      const packaged = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-File', script,
        binary, 'project.exe', 'project', f.identity.version, platform.id, platform.target, f.identity.source_sha, output,
      ], { encoding: 'utf8' });

      expect(packaged.status, packaged.stderr).toBe(0);
      const digest = sha256(fs.readFileSync(path.join(output, f.name)));
      const checksumPath = path.join(output, `${f.name}.sha256`);
      const checksum = fs.readFileSync(checksumPath);
      expect(checksum.equals(Buffer.from(`${digest}  ${f.name}\n`))).toBe(true);
      const result = f.assemble();
      expect(result.assets.map((asset) => asset.name)).toEqual([f.name, `${f.name}.sha256`]);
      expect(fs.readFileSync(path.join(f.options.outputRoot, 'assets', `${f.name}.sha256`)).equals(checksum)).toBe(true);

      for (const [label, record] of [
        ['missing-lf', `${digest}  ${f.name}`],
        ['crlf', `${digest}  ${f.name}\r\n`],
        ['wrong-digest', `${'0'.repeat(64)}  ${f.name}\n`],
      ]) {
        fs.writeFileSync(checksumPath, record);
        f.options.outputRoot = path.join(f.root, label);
        expect(f.assemble).toThrow(/checksum-mismatch/);
        expect(fs.existsSync(f.options.outputRoot)).toBe(false);
      }
    });
  });
});

describe("assembly", () => {
  describe("assembly", () => {
    for (const [label, mutate, error] of [
      ['source', (f) => { f.buildManifest.source_sha = 'c'.repeat(40); f.put('build/release-build-linux/asset-manifest.json', f.buildManifest); }, /source-identity-mismatch/],
      ['version', (f) => { f.buildManifest.version = '2.0.0'; f.put('build/release-build-linux/asset-manifest.json', f.buildManifest); }, /version-mismatch/],
      ['platform', (f) => { f.options.platformMatrix = JSON.stringify({ include: [{ id: 'other', runner: 'ubuntu-24.04', target: 'other' }] }); }, /platform-mismatch/],
      ['checksum', (f) => { f.put(`build/release-build-linux/${f.name}`, 'changed'); }, /checksum-mismatch/],
      ['extra file', (f) => { f.put('build/release-build-linux/extra', 'extra'); }, /asset-set-mismatch/],
      ['symlink', (f) => { fs.unlinkSync(path.join(f.root, 'build/release-build-linux', f.name)); fs.symlinkSync(f.options.authorityPath, path.join(f.root, 'build/release-build-linux', f.name)); }, /symlink-forbidden/],
      ['traversal', (f) => { f.buildManifest.assets[0].path = '../archive'; f.put('build/release-build-linux/asset-manifest.json', f.buildManifest); }, /asset-set-mismatch|asset-name-invalid/],
      ['snapshot', (f) => { f.snapshot.values.CI_SUPPLEMENTAL_RELEASE_ASSET_ENABLED = 'true'; f.put('snapshot.json', f.snapshot); }, /config-inconsistent/],
      ['unexpected supplemental', (f) => { f.options.supplementalRoot = f.root; }, /unexpected-supplemental-asset/],
    ]) {
      // contract_id: contract.ci-release-assembly.outputs
      // integration_id: release-assembly-rejection
      test(`assembly fails closed: ${label}`, (t) => {
        const f = fixture(t);
        mutate(f);
        expect(f.assemble).toThrow(error);
        expect(fs.existsSync(f.options.outputRoot)).toBe(false);
      });
    }
  });
});

describe("contract.ci-release-assembly.outputs", () => {
  describe("release-supplemental-evidence-binding", () => {
    // contract_id: contract.ci-release-assembly.outputs
    // integration_id: release-supplemental-evidence-binding
    test('supplemental evidence binds opaque owner records and rejects mismatches', (t) => {
      const f = fixture(t);
      f.snapshot.values.CI_SUPPLEMENTAL_RELEASE_ASSET_ENABLED = 'true';
      f.snapshot.values.CI_SUPPLEMENTAL_RELEASE_ASSET_OWNER_CONTRACT = 'installer.asset-evidence';
      f.snapshot.digest = sha256(Buffer.from(canonicalJson({ sources: f.snapshot.sources, values: f.snapshot.values })));
      f.authority.config_snapshot_digest = f.snapshot.digest;
      f.put('snapshot.json', f.snapshot);
      f.put('authority.json', f.authority);
      const asset = { path: 'installer.sh', sha256: sha256(Buffer.from('installer')), checksum_path: 'installer.sh.sha256', owner_evidence_path: 'owner.json', owner_evidence_sha256: sha256(Buffer.from('opaque owner record')), provenance_path: 'provenance.json', verification_path: 'verification.json' };
      f.put('supplemental/installer.sh', 'installer');
      f.put('supplemental/installer.sh.sha256', `${asset.sha256}  installer.sh\n`);
      f.put('supplemental/owner.json', 'opaque owner record');
      f.put('supplemental/provenance.json', 'opaque provenance');
      const attestation = { status: 'success', owner_contract: 'installer.asset-evidence', source_sha: f.identity.source_sha, asset_sha256: asset.sha256, owner_evidence_sha256: asset.owner_evidence_sha256, provenance_sha256: sha256(Buffer.from('opaque provenance')) };
      f.put('supplemental/verification.json', attestation);
      f.put('supplemental/supplemental-manifest.json', { schema_version: '1', kind: 'ci-github-supplemental-handoff', owner_contract: attestation.owner_contract, source_sha: f.identity.source_sha, version: f.identity.version, assets: [asset] });
      f.options.supplementalRoot = path.join(f.root, 'supplemental');
      f.put('supplemental/owner.json', 'changed');
      expect(f.assemble).toThrow(/supplemental-asset-evidence-mismatch/);
      f.put('supplemental/owner.json', 'opaque owner record');
      const result = f.assemble();
      expect(result.assets.length).toBe(4);
      expect(fs.readdirSync(path.join(f.options.outputRoot, 'evidence')).length).toBe(3);

      for (const target of ['owner.json', 'provenance.json', 'verification.json']) {
        f.put('supplemental/owner.json', 'opaque owner record');
        f.put('supplemental/provenance.json', 'opaque provenance');
        const verificationPath = f.put('supplemental/verification.json', attestation);
        f.options.outputRoot = path.join(f.root, `changed-${target}`);
        const read = fs.readFileSync;
        let changed = false;
        const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((file, options) => {
          const bytes = read(file, options);
          if (String(file) === verificationPath && !changed) {
            changed = true;
            f.put(`supplemental/${target}`, 'unverified replacement');
          }
          return bytes;
        });
        try {
          expect(f.assemble).toThrow(/checksum-mismatch/);
        } finally {
          spy.mockRestore();
        }
        expect(changed).toBe(true);
        expect(fs.existsSync(path.join(f.options.outputRoot, 'assembly.json'))).toBe(false);
        expect(fs.existsSync(path.join(f.options.outputRoot, 'handoff.json'))).toBe(false);
        expect(fs.readFileSync(path.join(f.options.supplementalRoot, target), 'utf8')).toBe('unverified replacement');
      }
    });
  });
});

describe("contract.ci-release-assembly.outputs", () => {
  describe("release-assembly-shape", () => {
    // contract_id: contract.ci-release-assembly.outputs
    // integration_id: release-assembly-shape
    test('evidence schema rejects unknown fields, missing fields and oversized inventories', () => {
      expect(() => validateEvidence('identity', {})).toThrow(/schema-mismatch/);
      expect(() => validateEvidence('asset', { name: 'a', sha256: 'a'.repeat(64), size: 1, extra: true })).toThrow(/schema-mismatch/);
      expect(() => validateEvidence('assets', Array.from({ length: 257 }, () => ({ name: 'a', sha256: 'a'.repeat(64), size: 1 })))).toThrow(/schema-mismatch/);
    });
  });
});
