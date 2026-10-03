import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { fixture } from './fixtures.mjs';
import { sha256, canonicalJson } from '../io.ts';
import { validateEvidence } from '../schema.ts';
import { loadAssembly } from '../observation.ts';

// contract_id: contract.ci-release-assembly.outputs
// integration_id: release-assembly-contract
test('assembly produces a bound handoff and rejects invalid build inputs', (t) => {
  const f = fixture(t);
  const result = f.assemble();
  assert.equal(result.assets.length, 2);
  assert.equal(result.identity.source_sha, f.identity.source_sha);
  assert.equal(loadAssembly({ ...f.options, handoffRoot: f.options.outputRoot }).assembly.asset_digest, result.asset_digest);
  assert.throws(f.assemble, /EEXIST/);
});

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
    assert.throws(f.assemble, error);
    assert.equal(fs.existsSync(f.options.outputRoot), false);
  });
}

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
  assert.throws(f.assemble, /supplemental-asset-evidence-mismatch/);
  f.put('supplemental/owner.json', 'opaque owner record');
  const result = f.assemble();
  assert.equal(result.assets.length, 4);
  assert.equal(fs.readdirSync(path.join(f.options.outputRoot, 'evidence')).length, 3);
});

// contract_id: contract.ci-release-assembly.outputs
// integration_id: release-assembly-shape
test('evidence schema rejects unknown fields, missing fields and oversized inventories', () => {
  assert.throws(() => validateEvidence('identity', {}), /schema-mismatch/);
  assert.throws(() => validateEvidence('asset', { name: 'a', sha256: 'a'.repeat(64), size: 1, extra: true }), /schema-mismatch/);
  assert.throws(() => validateEvidence('assets', Array.from({ length: 257 }, () => ({ name: 'a', sha256: 'a'.repeat(64), size: 1 }))), /schema-mismatch/);
});
