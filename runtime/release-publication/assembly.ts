import { FailureContext } from '../diagnostics/failure.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { validatePlatformManifestValue } from '../platform/platform-manifest-core.mjs';
import { sourceTextSha256 } from '../platform/source-text.mjs';
import { LIMITS, fail, record, equal, hex, assetName, safePath, readBytes, readRecord, parseJson, hashFile, sha256, writeNewJson } from './io';
import { identityFromAuthority, assetDigest, sortedAssets, validateEvidence } from './schema';
import type { AssemblyType } from './schema';
import { validateSnapshot } from './snapshot';

export type AssemblyOptionsType = {
  authorityPath: string; repository: string; snapshotPath: string; platformManifestPath: string;
  platformMatrix: string; buildRoot: string; supplementalRoot?: string; outputRoot: string;
};
export type ManifestDecoderType = (text: string) => unknown;
type FileType = { filename: string; name: string; sha256: string; size?: number };

function exactKeys(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!record(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail('manifest-shape-invalid');
};
const exactInventory = (observed: string[], expected: string[], field: string, code: string): void => {
  const missing = expected.filter((name) => !observed.includes(name)).sort();
  const extra = observed.filter((name) => !expected.includes(name)).sort();
  if (missing.length || extra.length) fail(code, { field, expected: expected.sort(), observed: observed.sort(), missing, extra });
};
export const assembleRelease = (options: AssemblyOptionsType, decodeManifest: ManifestDecoderType): AssemblyType => {
  const diagnostic = new FailureContext('ci-release-assembly', 'assemble');
  try {
    diagnostic.at('authority-binding', { input: 'authority-path' });
    const authority = readRecord(options.authorityPath);
    const identity = identityFromAuthority(authority, options.repository);
    diagnostic.confirmed();
    diagnostic.at('snapshot-binding', { input: 'snapshot-path', source: identity.source_sha, version: identity.version });
    const config = validateSnapshot(readRecord(options.snapshotPath), authority);
    if (config.CI_SUPPLEMENTAL_RELEASE_ASSET_ENABLED !== 'true' && config.CI_SUPPLEMENTAL_RELEASE_ASSET_ENABLED !== 'false') fail('supplemental-selection-invalid');
    const supplementalEnabled = config.CI_SUPPLEMENTAL_RELEASE_ASSET_ENABLED === 'true';
    if (supplementalEnabled !== Boolean(options.supplementalRoot)) fail(supplementalEnabled ? 'selected-supplemental-asset-missing' : 'unexpected-supplemental-asset');
    diagnostic.confirmed();
    diagnostic.at('platform-validation', { input: 'platform-manifest-path' });
    const platformBytes = readBytes(options.platformManifestPath, 65536);
    if (sourceTextSha256(platformBytes) !== authority.platform_manifest_sha256 || config.CI_PLATFORM_MANIFEST !== authority.platform_manifest) fail('platform-mismatch');
    const matrix: unknown = JSON.parse(options.platformMatrix);
    exactKeys(matrix, ['include']);
    const expectedMatrix = { include: validatePlatformManifestValue(decodeManifest(platformBytes.toString('utf8'))) };
    equal(matrix, expectedMatrix, 'platform-mismatch');
    const platforms = expectedMatrix.include;
    if (platforms.length > LIMITS.assets / 2) fail('platform-limit-exceeded');
    const expectedDirectories = platforms.map((platform) => `release-build-${platform.id}`).sort();
    diagnostic.confirmed();
    diagnostic.at('build-inventory', { input: 'build-root', source: identity.source_sha, version: identity.version });
    exactInventory(fs.readdirSync(options.buildRoot), expectedDirectories, 'build-directories', 'asset-set-mismatch');
    diagnostic.confirmed();
    const files: (FileType & { size: number })[] = [];
    const metadata: FileType[] = [];
    let totalBytes = 0;
    const addFile = (root: string, relative: unknown, inputName: unknown = relative): string => {
      const name = assetName(inputName);
      if (files.some((file) => file.name === name)) fail('asset-name-collision');
      const filename = safePath(root, relative);
      const size = fs.statSync(filename).size;
      totalBytes += size;
      if (files.length >= LIMITS.assets || totalBytes > LIMITS.totalBytes) fail('asset-limit-exceeded');
      const digest = hashFile(filename);
      files.push({ filename, name, sha256: digest, size });
      return digest;
    };
    const addAsset = (root: string, asset: Record<string, unknown>): void => {
      assetName(asset.path);
      if (asset.checksum_path !== `${asset.path}.sha256`) fail('checksum-mismatch');
      const digest = addFile(root, asset.path);
      if (digest !== hex(asset.sha256)) fail('checksum-mismatch', { field: 'sha256', asset: asset.path, expected: asset.sha256, observed: digest });
      const checksum = readBytes(safePath(root, asset.checksum_path), 1024).toString('utf8');
      const expectedChecksum = `${digest}  ${asset.path}\n`;
      if (checksum !== expectedChecksum) fail('checksum-mismatch', { field: 'checksum-sidecar-bytes', asset: asset.checksum_path, expected_sha256: sha256(Buffer.from(expectedChecksum)), observed_sha256: sha256(Buffer.from(checksum)) });
      addFile(root, asset.checksum_path);
    };
    for (const platform of platforms) {
      diagnostic.at('build-manifest', { platform: platform.id, target: platform.target, input: 'asset-manifest.json' });
      const root = safePath(options.buildRoot, `release-build-${platform.id}`, true);
      const manifest = readRecord(safePath(root, 'asset-manifest.json'));
      exactKeys(manifest, ['schema_version', 'kind', 'source_sha', 'version', 'platform_id', 'platform_target', 'assets']);
      if (manifest.schema_version !== '1' || manifest.kind !== 'ci-release-build-manifest') fail('manifest-shape-invalid');
      if (manifest.source_sha !== identity.source_sha) fail('source-identity-mismatch', { field: 'source_sha', expected: identity.source_sha, observed: typeof manifest.source_sha === 'string' && /^[a-f0-9]{40}$/.test(manifest.source_sha) ? manifest.source_sha : 'malformed-or-protected' });
      if (manifest.version !== identity.version) fail('version-mismatch', { field: 'version', expected: identity.version, observed: typeof manifest.version === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(manifest.version) ? manifest.version : 'malformed-or-protected' });
      if (manifest.platform_id !== platform.id || manifest.platform_target !== platform.target) fail('platform-mismatch');
      if (!Array.isArray(manifest.assets) || manifest.assets.length !== 1) fail('asset-set-mismatch');
      const buildAssets: unknown[] = manifest.assets;
      const asset = buildAssets[0];
      exactKeys(asset, ['path', 'sha256', 'checksum_path']);
      assetName(asset.path);
      assetName(asset.checksum_path);
      diagnostic.at('build-inventory', { platform: platform.id, target: platform.target });
      exactInventory(fs.readdirSync(root), ['asset-manifest.json', String(asset.path), String(asset.checksum_path)], 'build-files', 'asset-set-mismatch');
      diagnostic.confirmed();
      diagnostic.at('checksum-validation', { platform: platform.id, asset: asset.path });
      addAsset(root, asset);
    }
    diagnostic.confirmed();
    if (supplementalEnabled) {
      diagnostic.at('supplemental-binding', { input: 'supplemental-manifest.json' });
      const supplementalRoot = options.supplementalRoot;
      if (!supplementalRoot) fail('selected-supplemental-asset-missing');
      const manifest = readRecord(safePath(supplementalRoot, 'supplemental-manifest.json'));
      exactKeys(manifest, ['schema_version', 'kind', 'owner_contract', 'source_sha', 'version', 'assets']);
      if (manifest.schema_version !== '1' || manifest.kind !== 'ci-github-supplemental-handoff'
        || manifest.owner_contract !== config.CI_SUPPLEMENTAL_RELEASE_ASSET_OWNER_CONTRACT
        || typeof manifest.owner_contract !== 'string' || !/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(manifest.owner_contract)) fail('supplemental-asset-owner-contract-mismatch');
      if (manifest.source_sha !== identity.source_sha || manifest.version !== identity.version) fail('supplemental-asset-evidence-mismatch');
      if (!Array.isArray(manifest.assets) || !manifest.assets.length || manifest.assets.length > LIMITS.assets / 2) fail('supplemental-asset-evidence-mismatch');
      const allowed = new Set(['supplemental-manifest.json']);
      const supplementalAssets: unknown[] = manifest.assets;
      for (const asset of supplementalAssets) {
        exactKeys(asset, ['path', 'sha256', 'checksum_path', 'owner_evidence_path', 'owner_evidence_sha256', 'provenance_path', 'verification_path']);
        addAsset(supplementalRoot, asset);
        const evidencePath = safePath(supplementalRoot, asset.owner_evidence_path);
        const evidenceDigest = sha256(readBytes(evidencePath));
        if (evidenceDigest !== hex(asset.owner_evidence_sha256)) fail('supplemental-asset-evidence-mismatch', { field: 'owner_evidence_sha256', asset: asset.owner_evidence_path, expected: asset.owner_evidence_sha256, observed: evidenceDigest });
        const provenanceDigest = sha256(readBytes(safePath(supplementalRoot, asset.provenance_path)));
        const verificationBytes = readBytes(safePath(supplementalRoot, asset.verification_path));
        const attestation = parseJson(verificationBytes);
        if (!record(attestation)) fail('json-object-invalid');
        exactKeys(attestation, ['status', 'owner_contract', 'source_sha', 'asset_sha256', 'owner_evidence_sha256', 'provenance_sha256']);
        if (attestation.status !== 'success' || attestation.owner_contract !== manifest.owner_contract || attestation.source_sha !== identity.source_sha
          || attestation.asset_sha256 !== asset.sha256 || attestation.owner_evidence_sha256 !== asset.owner_evidence_sha256
          || attestation.provenance_sha256 !== provenanceDigest) fail('supplemental-asset-evidence-mismatch');
        for (const key of ['path', 'checksum_path', 'owner_evidence_path', 'provenance_path', 'verification_path']) allowed.add(assetName(asset[key]));
        const evidenceDigests = { owner_evidence_path: evidenceDigest, provenance_path: provenanceDigest, verification_path: sha256(verificationBytes) };
        for (const [key, digest] of Object.entries(evidenceDigests)) {
          assetName(asset[key]);
          const name = `evidence-${files.length}-${asset[key]}`;
          metadata.push({ filename: safePath(supplementalRoot, asset[key]), name, sha256: digest });
        }
      }
      diagnostic.at('supplemental-inventory', { input: 'supplemental-root' });
      exactInventory(fs.readdirSync(supplementalRoot), [...allowed], 'supplemental-files', 'unexpected-supplemental-asset');
    }
    const assets = sortedAssets(files.map(({ name, sha256: digest, size }) => ({ name, sha256: digest, size })));
    const manifest = [...assets.map((asset) => ({ path: `assets/${asset.name}`, sha256: asset.sha256 })), ...metadata.map((file) => ({ path: `evidence/${file.name}`, sha256: file.sha256 }))];
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
    const assembly = validateEvidence('assembly', {
      schema_version: '1', kind: 'ci-github-release-assembly', identity, assets,
      asset_digest: assetDigest(assets), manifest_sha256: sha256(manifestBytes),
    });
    diagnostic.confirmed();
    diagnostic.at('handoff-write', { output: 'output-directory', source: identity.source_sha, version: identity.version });
    fs.mkdirSync(options.outputRoot, { recursive: false });
    diagnostic.writeState = 'partial-output';
    fs.mkdirSync(path.join(options.outputRoot, 'assets'));
    fs.mkdirSync(path.join(options.outputRoot, 'evidence'));
    for (const file of [...files, ...metadata]) {
      const destination = path.join(options.outputRoot, files.some((asset) => asset === file) ? 'assets' : 'evidence', file.name);
      fs.copyFileSync(file.filename, destination, fs.constants.COPYFILE_EXCL);
      const copiedDigest = hashFile(destination);
      if (copiedDigest !== file.sha256) fail('checksum-mismatch', { field: 'copied-sha256', asset: file.name, expected: file.sha256, observed: copiedDigest });
    }
    fs.writeFileSync(path.join(options.outputRoot, 'manifest.json'), manifestBytes, { flag: 'wx' });
    writeNewJson(path.join(options.outputRoot, 'assembly.json'), assembly);
    writeNewJson(path.join(options.outputRoot, 'handoff.json'), { schema: 'ci.handoff.v1', source_sha: identity.source_sha, version: identity.version, target_identity: identity.target_identity, manifest: 'manifest.json' });
    diagnostic.confirmed();
    diagnostic.writeState = 'complete';
    return assembly;
  } catch (error) { throw diagnostic.capture(error); }
};
