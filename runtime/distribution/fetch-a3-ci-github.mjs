#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// This bootstrap remains a single file before the distribution has been fetched.
class DistributionError extends Error {
  constructor(message, options) {
    super(message, options);
    this.details = options?.diagnostics;
  }
}
const distributionFailureEvidence = (error, operation) => {
  const reason = error instanceof DistributionError && /^[a-z][a-z0-9-]+$/.test(error.message.split(':', 1)[0]) ? error.message.split(':', 1)[0] : 'distribution-unknown-failure';
  const detail = error instanceof DistributionError ? error.details : undefined;
  return {
    classification: { subject: 'ci-selective-distribution', operation, stage: detail?.stage ?? operation, reason, cause: reason === 'distribution-unknown-failure' ? 'unknown' : 'known' },
    context: { source: detail?.sourceRevision ?? 'unavailable', input: detail?.input ?? 'command-arguments', values: 'protected-or-unavailable' },
    comparison: detail?.comparison ?? (detail?.field ? Object.fromEntries(Object.entries(detail).filter(([key]) => ['field', 'expected', 'observed', 'expected_size', 'observed_size', 'expected_sha256', 'observed_sha256'].includes(key))) : { field: 'command-and-distribution-contract', expected: 'valid', observed: reason, values: 'protected-or-unavailable' }),
    'evidence-location': { log: 'stderr', transaction: detail?.transactionId ?? 'unavailable' },
    'execution-state': { outcome: 'failure', exit: 2, write: detail?.write ?? (/^(?:distribution-.+-required|distribution-cli-.+|distribution-manifest-source-exclusive)$/.test(reason) ? 'not-started' : 'unavailable'), rollback: detail?.rollback ?? 'unavailable', cleanup: detail?.cleanup ?? 'unavailable', ...(detail?.cleanupFailures ? { cleanupFailures: detail.cleanupFailures } : {}) },
    'next-check': { operation, rule: reason, input: detail?.input ?? 'command-arguments' },
  };
};

const retainDistributionFailure = (error, details) => {
  const failure = error instanceof DistributionError ? error : new DistributionError('distribution-unknown-failure', { cause: error });
  failure.details = { ...failure.details, ...details };
  return failure;
};

const releaseMutationLock = (handle, filename) => {
  const failures = [];
  try { fs.closeSync(handle); } catch (error) { failures.push({ operation: 'lock-close', error }); }
  try { fs.rmSync(filename, { force: true }); } catch (error) { failures.push({ operation: 'lock-remove', error }); }
  if (failures.length) throw new DistributionError('distribution-lock-cleanup-failed', {
    cause: failures[0].error,
    diagnostics: { cleanup: 'lock-cleanup-failed', cleanupFailures: failures.map((entry) => entry.operation) },
  });
};

const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;
const MANIFEST_KIND = 'a3-ci-github-distribution-manifest';
const RECEIPT_KIND = 'a3-ci-github-distribution-receipt';
const PLAN_KIND = 'a3-ci-github-distribution-plan';
const TRANSACTION_KIND = 'a3-ci-github-distribution-transaction';
const REPOSITORY = 'a3-suite/a3-ci-github';
const RAW_ORIGIN = 'https://raw.githubusercontent.com';
const MANIFEST_ASSET = 'a3-ci-github-distribution-manifest.json';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const readJson = (filename) => JSON.parse(fs.readFileSync(filename, 'utf8'));
const normalizeRelative = (value) => {
  if (typeof value !== 'string' || value === '' || value.includes('\0')) {
    throw new DistributionError('distribution-path-invalid');
  }
  const normalized = value.replaceAll('\\', '/');
  if (path.posix.isAbsolute(normalized) || normalized.split('/').some((part) => part === '..')) {
    throw new DistributionError(`distribution-path-outside-root:${value}`);
  }
  return normalized.replace(/^\.\//, '');
};
const inside = (root, relative) => {
  const normalized = normalizeRelative(relative);
  const resolved = path.resolve(root, normalized);
  const relativeToRoot = path.relative(path.resolve(root), resolved);
  if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
    throw new DistributionError(`distribution-path-outside-root:${relative}`);
  }
  return resolved;
};
const regularFile = (filename, diagnostic) => {
  let stat;
  try {
    stat = fs.lstatSync(filename);
  } catch (error) {
    if (error.code === 'ENOENT') throw new DistributionError(diagnostic, { cause: error });
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new DistributionError(diagnostic);
};
const assertResolvedInside = (root, target, diagnostic) => {
  const rootReal = fs.realpathSync(root);
  let existing = target;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new DistributionError(diagnostic);
    existing = parent;
  }
  const existingReal = fs.realpathSync(existing);
  const relative = path.relative(rootReal, existingReal);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new DistributionError(diagnostic);
};
const writeExclusiveDirectory = (directory) => {
  fs.mkdirSync(directory, { recursive: false });
};
const ensureDirectoryInside = (root, directory, diagnostic) => {
  assertResolvedInside(root, directory, diagnostic);
  fs.mkdirSync(directory, { recursive: true });
  assertResolvedInside(root, directory, diagnostic);
};

const atomicWrite = (filename, bytes) => {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.tmp-${process.pid}-${randomUUID()}`;
  fs.writeFileSync(temporary, bytes, { flag: 'wx' });
  fs.renameSync(temporary, filename);
};

export const validateDistributionManifest = (manifest) => {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new DistributionError('distribution-manifest-invalid');
  }
  if (manifest.schemaVersion !== '2' || manifest.kind !== MANIFEST_KIND) {
    throw new DistributionError('distribution-manifest-contract-unsupported');
  }
  if (manifest.repository !== REPOSITORY || manifest.rawOrigin !== RAW_ORIGIN) {
    throw new DistributionError('distribution-manifest-source-untrusted');
  }
  if (!FULL_SHA.test(String(manifest.sourceRevision ?? ''))) {
    throw new DistributionError('distribution-manifest-source-revision-invalid');
  }
  if (!RELEASE_TAG.test(String(manifest.releaseTag ?? ''))) {
    throw new DistributionError('distribution-manifest-release-tag-invalid');
  }
  if (!Array.isArray(manifest.assets) || !Array.isArray(manifest.presets)
    || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
    throw new DistributionError('distribution-manifest-shape-invalid');
  }
  if (!manifest.workflowTemplates || !manifest.workflowReferences || !manifest.reusableWorkflows
    || [manifest.workflowTemplates, manifest.workflowReferences, manifest.reusableWorkflows]
      .some((value) => typeof value !== 'object' || Array.isArray(value))) {
    throw new DistributionError('distribution-manifest-template-contract-invalid');
  }
  for (const reference of Object.values(manifest.workflowReferences)) {
    if (!FULL_SHA.test(String(reference))) throw new DistributionError('distribution-manifest-workflow-reference-invalid');
  }
  for (const [source, binding] of Object.entries(manifest.reusableWorkflows)) {
    if (!/^\.github\/workflows\/ci-[a-z0-9-]+\.yml$/.test(source)
      || binding.sourceRevision !== manifest.sourceRevision
      || !/^<[a-z0-9-]+-workflow-sha>$/.test(binding.referencePlaceholder)
      || manifest.workflowReferences[binding.referencePlaceholder.slice(1, -1)] !== manifest.sourceRevision) {
      throw new DistributionError(`distribution-manifest-workflow-binding-invalid:${source}`);
    }
  }
  const assetIds = new Set();
  for (const asset of manifest.assets) {
    if (!asset || typeof asset.id !== 'string' || assetIds.has(asset.id)
      || !Array.isArray(asset.files) || !Array.isArray(asset.dependencies)) {
      throw new DistributionError('distribution-manifest-asset-invalid');
    }
    assetIds.add(asset.id);
    for (const file of asset.files) {
      const sourcePath = normalizeRelative(file.sourcePath);
      const record = manifest.files[sourcePath];
      if (!record || !SHA256.test(String(record.sha256 ?? ''))
        || !Number.isSafeInteger(record.size) || record.size < 0) {
        throw new DistributionError(`distribution-manifest-file-invalid:${sourcePath}`);
      }
      if (file.destination !== undefined) normalizeRelative(file.destination);
      if (asset.application === 'copy') {
        const template = manifest.workflowTemplates[sourcePath];
        if (!template || !Array.isArray(template.emptyAllowed)
          || template.emptyAllowed.some((value) => typeof value !== 'string')
          || !template.triggerExtensions || typeof template.triggerExtensions !== 'object') {
          throw new DistributionError(`distribution-manifest-template-invalid:${sourcePath}`);
        }
      }
    }
  }
  for (const asset of manifest.assets) {
    for (const dependency of asset.dependencies) {
      if (!assetIds.has(dependency)) throw new DistributionError(`distribution-dependency-unknown:${dependency}`);
    }
  }
  for (const preset of manifest.presets) {
    if (!preset || typeof preset.id !== 'string' || !Array.isArray(preset.requiredAssets)
      || !Array.isArray(preset.optionalAssets)) {
      throw new DistributionError('distribution-manifest-preset-invalid');
    }
    for (const assetId of [...preset.requiredAssets, ...preset.optionalAssets]) {
      if (!assetIds.has(assetId)) throw new DistributionError(`distribution-preset-asset-unknown:${assetId}`);
    }
  }
  return manifest;
};

export const resolveDistributionSelection = (manifest, requestedPresets, requestedAssets) => {
  validateDistributionManifest(manifest);
  if (requestedPresets.length === 0 && requestedAssets.length === 0) {
    throw new DistributionError('distribution-selection-required');
  }
  const assets = new Map(manifest.assets.map((asset) => [asset.id, asset]));
  const presets = new Map(manifest.presets.map((preset) => [preset.id, preset]));
  const selected = new Set();
  const addClosure = (assetId, chain = []) => {
    if (chain.includes(assetId)) throw new DistributionError(`distribution-dependency-cycle:${[...chain, assetId].join('>')}`);
    selected.add(assetId);
    const asset = assets.get(assetId);
    for (const dependency of asset.dependencies) addClosure(dependency, [...chain, assetId]);
  };
  for (const presetId of requestedPresets) {
    const preset = presets.get(presetId);
    if (!preset) throw new DistributionError(`distribution-preset-unknown:${presetId}`);
    preset.requiredAssets.forEach((assetId) => addClosure(assetId));
  }
  for (const assetId of requestedAssets) {
    if (!assets.has(assetId)) throw new DistributionError(`distribution-asset-unknown:${assetId}`);
    selected.add(assetId);
  }
  for (const assetId of requestedAssets) {
    const asset = assets.get(assetId);
    for (const dependency of asset.dependencies) {
      if (!selected.has(dependency)) {
        throw new DistributionError(`distribution-dependency-missing:${assetId}:${dependency}`);
      }
    }
  }
  return [...selected].sort().map((assetId) => assets.get(assetId));
};

const allowedDownloadUrl = (candidate, initialPrefix) => {
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (candidate.startsWith(initialPrefix)) return true;
  return initialPrefix.startsWith(`https://github.com/${REPOSITORY}/releases/download/`)
    && ['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(parsed.hostname);
};

const fetchBytes = async (url, allowedPrefix) => {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      let currentUrl = String(url);
      for (let redirects = 0; redirects <= 5; redirects += 1) {
        if (!allowedDownloadUrl(currentUrl, allowedPrefix)) {
          throw new DistributionError('distribution-download-redirect-untrusted');
        }
        const response = await fetch(currentUrl, {
          redirect: 'manual',
          signal: AbortSignal.timeout(20_000),
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          if (!location) throw new DistributionError('distribution-download-redirect-location-missing');
          currentUrl = new URL(location, currentUrl).href;
          continue;
        }
        if (!response.ok) throw new DistributionError(`http-${response.status}`);
        return Buffer.from(await response.arrayBuffer());
      }
      throw new DistributionError('distribution-download-redirect-limit');
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
  }
  throw new DistributionError(`distribution-download-failed:${lastError instanceof DistributionError && /^[a-z][a-z0-9-]+$/.test(lastError.message.split(':')[0]) ? lastError.message.split(':')[0] : 'network-result-unknown'}`, { cause: lastError, diagnostics: { stage: 'asset-download', input: 'fixed-release-or-source-origin', field: 'download-response', expected: 'complete-trusted-response', observed: lastError instanceof DistributionError ? lastError.message.split(':')[0] : 'network-result-unknown' } });
};

export const loadDistributionManifest = async ({ manifestPath, manifestUrl }) => {
  if (Boolean(manifestPath) === Boolean(manifestUrl)) throw new DistributionError('distribution-manifest-source-exclusive');
  let bytes;
  if (manifestPath) {
    const resolved = path.resolve(manifestPath);
    regularFile(resolved, 'distribution-manifest-not-regular');
    bytes = fs.readFileSync(resolved);
  } else {
    const expectedPrefix = `https://github.com/${REPOSITORY}/releases/download/`;
    if (!String(manifestUrl).startsWith(expectedPrefix)
      || !String(manifestUrl).endsWith(`/${MANIFEST_ASSET}`)) {
      throw new DistributionError('distribution-manifest-url-untrusted');
    }
    bytes = await fetchBytes(manifestUrl, expectedPrefix);
  }
  const manifest = validateDistributionManifest(JSON.parse(bytes.toString('utf8')));
  if (manifestUrl && !String(manifestUrl).includes(`/download/${manifest.releaseTag}/${MANIFEST_ASSET}`)) {
    throw new DistributionError('distribution-manifest-release-url-mismatch');
  }
  return { manifest, bytes };
};

const selectedFileRecords = (assets) => {
  const records = new Map();
  for (const asset of assets) {
    for (const file of asset.files) {
      const key = normalizeRelative(file.sourcePath);
      const existing = records.get(key);
      if (existing && JSON.stringify(existing) !== JSON.stringify(file)) {
        throw new DistributionError(`distribution-file-mapping-conflict:${key}`);
      }
      records.set(key, file);
    }
  }
  return [...records.values()].sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
};

export const fetchDistribution = async ({
  projectRoot,
  manifest,
  manifestBytes,
  requestedPresets,
  requestedAssets,
  sourceRoot,
  download = fetchBytes,
}) => {
  const selectedAssets = resolveDistributionSelection(manifest, requestedPresets, requestedAssets);
  const files = selectedFileRecords(selectedAssets);
  const stateRoot = path.resolve(projectRoot, '.a3-skills/ci-github');
  ensureDirectoryInside(projectRoot, stateRoot, 'distribution-state-root-outside-project');
  const stagingRoot = path.join(stateRoot, `.staging-${randomUUID()}`);
  writeExclusiveDirectory(stagingRoot);
  const distributionRoot = path.join(stateRoot, 'distributions', manifest.sourceRevision);
  const fetchLock = path.join(distributionRoot, '.fetch.lock');
  let fetchLockHandle;
  let primaryFailure;
  let failed = false;
  let write = 'not-started';
  try {
    assertResolvedInside(projectRoot, distributionRoot, 'distribution-local-root-outside-project');
    const reusableFiles = new Set();
    if (!sourceRoot && fs.existsSync(distributionRoot)) {
      try {
        fetchLockHandle = fs.openSync(fetchLock, 'wx');
      } catch {
        throw new DistributionError('distribution-fetch-locked');
      }
      const existingReceipt = loadFetchedDistribution(projectRoot, manifest.sourceRevision).receipt;
      if (existingReceipt.manifestSha256 !== sha256(manifestBytes)) {
        throw new DistributionError('distribution-existing-root-conflict');
      }
      for (const sourcePath of existingReceipt.files) reusableFiles.add(sourcePath);
    }
    for (const file of files) {
      const sourcePath = normalizeRelative(file.sourcePath);
      if (reusableFiles.has(sourcePath)) continue;
      let bytes;
      if (sourceRoot) {
        const resolvedSourceRoot = path.resolve(sourceRoot);
        const source = inside(resolvedSourceRoot, sourcePath);
        assertResolvedInside(resolvedSourceRoot, source, `distribution-source-outside-root:${sourcePath}`);
        regularFile(source, `distribution-source-not-regular:${sourcePath}`);
        bytes = fs.readFileSync(source);
      } else {
        const url = `${manifest.rawOrigin}/${manifest.repository}/${manifest.sourceRevision}/${sourcePath}`;
        const prefix = `${manifest.rawOrigin}/${manifest.repository}/${manifest.sourceRevision}/`;
        bytes = await download(url, prefix);
      }
      const expected = manifest.files[sourcePath];
      if (bytes.length !== expected.size || sha256(bytes) !== expected.sha256) {
        throw new DistributionError(`distribution-file-integrity-mismatch:${sourcePath}`, { diagnostics: { stage: 'asset-download-validation', input: 'manifest.files', sourceRevision: manifest.sourceRevision, field: sourcePath, expected_size: expected.size, observed_size: bytes.length, expected_sha256: expected.sha256, observed_sha256: sha256(bytes) } });
      }
      const target = inside(stagingRoot, sourcePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes, { flag: 'wx' });
    }
    const receipt = {
      schemaVersion: '1',
      kind: RECEIPT_KIND,
      sourceRevision: manifest.sourceRevision,
      manifestSha256: sha256(manifestBytes),
      selectedPresets: [...new Set(requestedPresets)].sort(),
      selectedAssets: selectedAssets.map((asset) => asset.id),
      files: files.map((file) => file.sourcePath),
      status: 'fetched',
    };
    fs.writeFileSync(path.join(stagingRoot, 'manifest.json'), manifestBytes, { flag: 'wx' });
    fs.writeFileSync(path.join(stagingRoot, 'receipt.json'), jsonBytes(receipt), { flag: 'wx' });
    ensureDirectoryInside(projectRoot, path.dirname(distributionRoot), 'distribution-local-root-outside-project');
    assertResolvedInside(projectRoot, distributionRoot, 'distribution-local-root-outside-project');
    if (fs.existsSync(distributionRoot)) {
      if (fetchLockHandle === undefined) {
        try {
          fetchLockHandle = fs.openSync(fetchLock, 'wx');
        } catch {
          throw new DistributionError('distribution-fetch-locked');
        }
      }
      const existingReceipt = loadFetchedDistribution(projectRoot, manifest.sourceRevision).receipt;
      if (existingReceipt.manifestSha256 !== receipt.manifestSha256) {
        throw new DistributionError('distribution-existing-root-conflict');
      }
      for (const file of files) {
        const existing = inside(distributionRoot, file.sourcePath);
        assertResolvedInside(distributionRoot, existing, `distribution-local-file-outside-root:${file.sourcePath}`);
        if (fs.existsSync(existing)) {
          if (sha256(fs.readFileSync(existing)) !== manifest.files[file.sourcePath].sha256) {
            throw new DistributionError(`distribution-existing-file-conflict:${file.sourcePath}`);
          }
          continue;
        }
        const staged = inside(stagingRoot, file.sourcePath);
        fs.mkdirSync(path.dirname(existing), { recursive: true });
        write = 'partial-output';
        fs.copyFileSync(staged, existing, fs.constants.COPYFILE_EXCL);
      }
      const mergedReceipt = {
        ...receipt,
        selectedPresets: [...new Set([...existingReceipt.selectedPresets, ...receipt.selectedPresets])].sort(),
        selectedAssets: [...new Set([...existingReceipt.selectedAssets, ...receipt.selectedAssets])].sort(),
        files: [...new Set([...existingReceipt.files, ...receipt.files])].sort(),
      };
      write = 'partial-output';
      atomicWrite(path.join(distributionRoot, 'receipt.json'), jsonBytes(mergedReceipt));
      write = 'merged';
      return { ...mergedReceipt, distributionRoot, action: 'merged' };
    }
    fs.renameSync(stagingRoot, distributionRoot);
    write = 'fetched';
    return { ...receipt, distributionRoot, action: 'fetched' };
  } catch (error) {
    failed = true;
    primaryFailure = error;
    throw error;
  } finally {
    let cleanupFailure;
    try {
      if (fetchLockHandle !== undefined) releaseMutationLock(fetchLockHandle, fetchLock);
    } catch (error) { cleanupFailure = error; }
    try {
      if (fs.existsSync(stagingRoot)) fs.rmSync(stagingRoot, { recursive: true, force: true });
    } catch (error) {
      const failures = [...(cleanupFailure?.details?.cleanupFailures ?? []), 'staging-remove'];
      cleanupFailure = new DistributionError('distribution-fetch-cleanup-failed', {
        cause: cleanupFailure ?? error, diagnostics: { cleanup: 'staging-cleanup-failed', cleanupFailures: failures },
      });
    }
    if (cleanupFailure) {
      throw retainDistributionFailure(failed ? primaryFailure : cleanupFailure, {
        stage: failed ? primaryFailure instanceof DistributionError ? primaryFailure.details?.stage ?? 'fetch' : 'fetch' : 'fetch-cleanup',
        sourceRevision: manifest.sourceRevision, input: 'selected-distribution', write,
        ...cleanupFailure.details,
      });
    }
  }
};

const loadFetchedDistribution = (projectRoot, sourceRevision) => {
  if (!FULL_SHA.test(sourceRevision)) throw new DistributionError('distribution-source-revision-invalid');
  const root = path.resolve(projectRoot, '.a3-skills/ci-github/distributions', sourceRevision);
  assertResolvedInside(projectRoot, root, 'distribution-local-root-outside-project');
  regularFile(path.join(root, 'manifest.json'), 'distribution-local-manifest-missing');
  regularFile(path.join(root, 'receipt.json'), 'distribution-local-receipt-missing');
  const manifestBytes = fs.readFileSync(path.join(root, 'manifest.json'));
  const manifest = validateDistributionManifest(JSON.parse(manifestBytes.toString('utf8')));
  const receipt = readJson(path.join(root, 'receipt.json'));
  if (receipt.kind !== RECEIPT_KIND || receipt.sourceRevision !== sourceRevision
    || receipt.manifestSha256 !== sha256(manifestBytes) || receipt.status !== 'fetched'
    || !Array.isArray(receipt.selectedPresets) || !Array.isArray(receipt.selectedAssets)
    || !Array.isArray(receipt.files)) {
    throw new DistributionError('distribution-local-receipt-invalid');
  }
  const knownAssets = new Set(manifest.assets.map((asset) => asset.id));
  if (receipt.selectedAssets.some((assetId) => !knownAssets.has(assetId))) {
    throw new DistributionError('distribution-local-receipt-asset-invalid');
  }
  for (const sourcePath of receipt.files) {
    const expected = manifest.files[sourcePath];
    if (!expected) throw new DistributionError(`distribution-local-receipt-file-invalid:${sourcePath}`);
    const localFile = inside(root, sourcePath);
    assertResolvedInside(root, localFile, `distribution-local-file-outside-root:${sourcePath}`);
    regularFile(localFile, `distribution-local-file-not-regular:${sourcePath}`);
    const bytes = fs.readFileSync(localFile);
    if (bytes.length !== expected.size || sha256(bytes) !== expected.sha256) {
      throw new DistributionError(`distribution-local-file-integrity-mismatch:${sourcePath}`, { diagnostics: { stage: 'local-file-verification', input: 'manifest.files', sourceRevision: manifest.sourceRevision, field: sourcePath, expected_size: expected.size, observed_size: bytes.length, expected_sha256: expected.sha256, observed_sha256: sha256(bytes) } });
    }
  }
  return { root, manifest, receipt, manifestBytes };
};

export const verifyFetchedDistribution = ({ projectRoot, sourceRevision }) => {
  const { receipt } = loadFetchedDistribution(projectRoot, sourceRevision);
  return {
    schemaVersion: '1',
    kind: 'a3-ci-github-distribution-verification',
    sourceRevision,
    selectedAssets: receipt.selectedAssets,
    filesVerified: receipt.files.length,
    status: 'verified',
  };
};

const digestIfFile = (filename) => {
  if (!fs.existsSync(filename)) return null;
  regularFile(filename, `distribution-destination-not-regular:${filename}`);
  return sha256(fs.readFileSync(filename));
};

export const planDistributionApplication = ({ projectRoot, sourceRevision, requestedPresets, requestedAssets, settings = {}, yaml }) => {
  const loaded = loadFetchedDistribution(projectRoot, sourceRevision);
  const selectedAssets = resolveDistributionSelection(loaded.manifest, requestedPresets, requestedAssets);
  const selectedPresetDefinitions = loaded.manifest.presets.filter(
    (preset) => requestedPresets.includes(preset.id),
  );
  for (const asset of selectedAssets.filter((candidate) => candidate.application === 'copy')) {
    if (!selectedPresetDefinitions.some((preset) => (
      preset.requiredAssets.includes(asset.id) || preset.optionalAssets.includes(asset.id)
    ))) {
      throw new DistributionError(`distribution-copy-requires-matching-preset:${asset.id}`);
    }
  }
  const missingFetched = selectedAssets.map((asset) => asset.id)
    .filter((assetId) => !loaded.receipt.selectedAssets.includes(assetId));
  if (missingFetched.length > 0) throw new DistributionError(`distribution-selection-not-fetched:${missingFetched.join(',')}`);
  const lockPath = path.resolve(projectRoot, '.ci/ci-assets.lock.json');
  let priorLockBytes = null;
  if (fs.existsSync(lockPath)) {
    regularFile(lockPath, 'distribution-prior-asset-lock-invalid');
    priorLockBytes = fs.readFileSync(lockPath);
  }
  const priorLock = priorLockBytes === null ? null : JSON.parse(priorLockBytes.toString('utf8'));
  if (priorLock && (priorLock.schemaVersion !== '1' || priorLock.kind !== 'ci-github-asset-lock'
    || !FULL_SHA.test(String(priorLock.sourceRevision ?? '')) || !Array.isArray(priorLock.assets))) {
    throw new DistributionError('distribution-prior-asset-lock-invalid');
  }
  const priorAssets = new Map();
  for (const asset of priorLock?.assets ?? []) {
    if (!asset || typeof asset.path !== 'string' || priorAssets.has(asset.path)
      || !SHA256.test(String(asset.appliedSha256 ?? ''))) {
      throw new DistributionError('distribution-prior-asset-lock-invalid');
    }
    priorAssets.set(asset.path, asset);
  }
  const actions = [];
  const templates = loaded.manifest.workflowTemplates;
  const templateSource = 'runtime/preset/workflow-template.mjs';
  const templateRuntime = selectedAssets.some((asset) => asset.application === 'copy')
    ? createRequire(import.meta.url)(inside(loaded.root, templateSource)) : undefined;
  const yamlPackage = path.resolve(projectRoot, '.a3-skills/ci-github/runtime/node_modules/yaml');
  if (templateRuntime && !yaml) {
    assertResolvedInside(projectRoot, yamlPackage, 'distribution-template-runtime-outside-project');
    regularFile(path.join(yamlPackage, 'package.json'), 'distribution-template-runtime-not-prepared');
  }
  const yamlRuntime = templateRuntime ? yaml ?? createRequire(import.meta.url)(yamlPackage) : undefined;
  const selectedTemplateIds = selectedAssets.filter((asset) => asset.application === 'copy').map((asset) => asset.id);
  for (const assetId of Object.keys(settings)) {
    if (!selectedTemplateIds.includes(assetId)) throw new DistributionError(`distribution-template-settings-unselected:${assetId}`);
  }
  for (const asset of selectedAssets.filter((candidate) => candidate.application === 'copy')) {
    for (const file of asset.files) {
      if (!file.destination) throw new DistributionError(`distribution-copy-destination-missing:${asset.id}`);
      const source = inside(loaded.root, file.sourcePath);
      const destination = inside(projectRoot, file.destination);
      assertResolvedInside(projectRoot, destination, `distribution-destination-outside-root:${file.destination}`);
      const sourceSha256 = sha256(fs.readFileSync(source));
      const destinationSha256 = digestIfFile(destination);
      const template = templates[file.sourcePath];
      let generatedContent;
      const ownedDestination = priorAssets.get(file.destination)?.appliedSha256 === destinationSha256;
      if (template && (destinationSha256 === null || ownedDestination)) {
        const sourceText = fs.readFileSync(source, 'utf8');
        for (const marker of sourceText.matchAll(/<([a-z0-9-]+-workflow-sha)>/g)) {
          if (!Object.values(loaded.manifest.reusableWorkflows).some((binding) => binding.referencePlaceholder === marker[0])) {
            throw new DistributionError(`distribution-provider-binding-missing:${marker[1]}`);
          }
        }
        let previous = { values: {}, extensions: {} };
        if (destinationSha256 !== null && priorAssets.has(file.destination)) {
          const previousDistribution = loadFetchedDistribution(projectRoot, priorLock.sourceRevision);
          const previousAsset = previousDistribution.manifest.assets.flatMap((asset) => asset.files)
            .find((entry) => entry.destination === file.destination);
          if (!previousAsset) throw new DistributionError(`distribution-template-prior-source-missing:${file.destination}`);
          previous = templateRuntime.readWorkflowSettings({
            yaml: yamlRuntime,
            template: fs.readFileSync(inside(previousDistribution.root, previousAsset.sourcePath), 'utf8'),
            current: fs.readFileSync(destination, 'utf8'),
            triggerExtensions: previousDistribution.manifest.workflowTemplates?.[previousAsset.sourcePath]?.triggerExtensions ?? {},
          });
          for (const extension of Object.keys(previous.extensions)) {
            if (!Object.hasOwn(template.triggerExtensions, extension)) throw new DistributionError(`distribution-template-trigger-no-longer-supported:${extension}`);
          }
        }
        generatedContent = templateRuntime.renderWorkflowTemplate({
          yaml: yamlRuntime, template: sourceText,
          values: { ...previous.values, ...(settings[asset.id] ?? {}) },
          references: loaded.manifest.workflowReferences,
          emptyAllowed: template.emptyAllowed,
          extensions: previous.extensions,
        });
      }
      const generatedSha256 = generatedContent === undefined ? sourceSha256 : sha256(Buffer.from(generatedContent));
      let action = 'create';
      if (template && destinationSha256 !== null && !ownedDestination) action = 'conflict';
      else if (destinationSha256 === generatedSha256) action = 'reuse';
      else if (destinationSha256 !== null) {
        const prior = priorAssets.get(file.destination);
        action = prior?.appliedSha256 === destinationSha256 ? 'update' : 'conflict';
      }
      actions.push({
        assetId: asset.id,
        sourcePath: file.sourcePath,
        destination: file.destination,
        sourceSha256,
        destinationSha256,
        action,
        generatedSha256,
        ...(generatedContent === undefined ? {} : { generatedContent }),
      });
    }
  }
  if (templateRuntime) {
    const registryAsset = loaded.manifest.assets.find((asset) => asset.id === 'registry.ci-github');
    const registrySource = registryAsset?.files.find((file) => file.sourcePath.endsWith('/ci-github-preset-assets.reference.yml'))?.sourcePath;
    if (!registrySource || !loaded.receipt.files.includes(registrySource)) throw new DistributionError('distribution-pin-registry-not-fetched');
    const providerActions = yamlRuntime.parse(fs.readFileSync(inside(loaded.root, registrySource), 'utf8')).providerActions;
    const projection = templateRuntime.projectProviderActionPins(providerActions.entries, providerActions.pinCompanion.fields);
    const callerTexts = actions.map((entry) => entry.generatedContent ?? (
      entry.destinationSha256 === null ? '' : fs.readFileSync(inside(projectRoot, entry.destination), 'utf8')));
    const selectedPaths = new Set(actions.map((entry) => entry.destination));
    for (const preset of loaded.manifest.presets) {
      for (const assetId of [...preset.requiredAssets, ...preset.optionalAssets]) {
        const asset = loaded.manifest.assets.find((candidate) => candidate.id === assetId);
        for (const file of asset?.application === 'copy' ? asset.files : []) {
          if (file.destination && !selectedPaths.has(file.destination) && priorAssets.has(file.destination)) {
            const current = inside(projectRoot, file.destination);
            assertResolvedInside(projectRoot, current, `distribution-destination-outside-root:${file.destination}`);
            if (fs.existsSync(current)) callerTexts.push(fs.readFileSync(current, 'utf8'));
          }
        }
      }
    }
    const requiresPins = callerTexts.some((text) => [...templateRuntime.providerActionPinRepositories(yamlRuntime.parse(text))]
      .some((action) => Object.hasOwn(projection, action)));
    if (requiresPins) {
      const destination = providerActions.pinCompanion.path;
      const absolute = inside(projectRoot, destination);
      assertResolvedInside(projectRoot, absolute, `distribution-destination-outside-root:${destination}`);
      const generatedContent = yamlRuntime.stringify(projection);
      const generatedSha256 = sha256(Buffer.from(generatedContent));
      const destinationSha256 = digestIfFile(absolute);
      const action = destinationSha256 === null ? 'create' : destinationSha256 === generatedSha256 ? 'reuse'
        : priorAssets.get(destination)?.appliedSha256 === destinationSha256 ? 'update' : 'conflict';
      actions.push({ assetId: registryAsset.id, sourcePath: registrySource, destination,
        sourceSha256: sha256(fs.readFileSync(inside(loaded.root, registrySource))), destinationSha256,
        action, generatedSha256, generatedContent });
    }
  }
  const selectedDestinations = new Set(actions.map((entry) => entry.destination));
  const stale = [...priorAssets.keys()].filter((destination) => !selectedDestinations.has(destination)).sort();
  const planWithoutDigest = {
    schemaVersion: '1',
    kind: PLAN_KIND,
    sourceRevision,
    manifestSha256: loaded.receipt.manifestSha256,
    priorAssetLock: {
      exists: priorLockBytes !== null,
      sha256: priorLockBytes === null ? null : sha256(priorLockBytes),
    },
    selectedPresets: [...new Set(requestedPresets)].sort(),
    selectedAssets: selectedAssets.map((asset) => asset.id),
    actions: actions.sort((left, right) => left.destination.localeCompare(right.destination)),
    stale,
  };
  const planDigest = sha256(jsonBytes(planWithoutDigest));
  const plan = { ...planWithoutDigest, planDigest };
  const planPath = path.resolve(projectRoot, '.a3-skills/ci-github/plans', `${planDigest}.json`);
  assertResolvedInside(projectRoot, planPath, 'distribution-plan-path-outside-project');
  atomicWrite(planPath, jsonBytes(plan));
  return { ...plan, planPath };
};

const acquireMutationLock = (lockPath) => {
  let handle;
  try {
    handle = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(handle, jsonBytes({ pid: process.pid, createdAt: new Date().toISOString() }));
    return handle;
  } catch (error) {
    const failure = new DistributionError('distribution-apply-locked', { cause: error });
    if (handle !== undefined) {
      try { releaseMutationLock(handle, lockPath); }
      catch (cleanupError) { failure.details = cleanupError.details; }
    }
    throw failure;
  }
};

const persistTransaction = (transactionRoot, transaction) => {
  const transactionPath = path.join(transactionRoot, 'transaction.json');
  assertResolvedInside(transactionRoot, transactionPath, 'distribution-transaction-path-outside-root');
  atomicWrite(transactionPath, jsonBytes(transaction));
};

const validateRollbackEntry = (projectRoot, transactionRoot, entry) => {
  const destination = inside(projectRoot, entry.destination);
  assertResolvedInside(projectRoot, destination, `distribution-destination-outside-root:${entry.destination}`);
  const currentSha256 = digestIfFile(destination);
  if (currentSha256 !== entry.afterSha256 && currentSha256 !== entry.beforeSha256) {
    throw new DistributionError(`distribution-rollback-destination-changed:${entry.destination}`);
  }
  let beforeBytes = null;
  if (entry.beforeSha256 !== null) {
    const backup = inside(transactionRoot, `before/${entry.destination}`);
    assertResolvedInside(transactionRoot, backup, `distribution-backup-outside-transaction:${entry.destination}`);
    regularFile(backup, `distribution-backup-missing:${entry.destination}`);
    beforeBytes = fs.readFileSync(backup);
    if (sha256(beforeBytes) !== entry.beforeSha256) {
      throw new DistributionError(`distribution-backup-integrity-mismatch:${entry.destination}`);
    }
  }
  return { destination, currentSha256, beforeBytes };
};

const validateRollbackInputs = (projectRoot, transactionRoot, transaction) => {
  for (const entry of transaction.actions) {
    if (['pending', 'not-applied'].includes(entry.state)) continue;
    validateRollbackEntry(projectRoot, transactionRoot, entry);
  }
};

const restoreTransaction = (projectRoot, transactionRoot, transaction) => {
  validateRollbackInputs(projectRoot, transactionRoot, transaction);
  transaction.status = 'rolling-back';
  persistTransaction(transactionRoot, transaction);
  try {
    for (const entry of [...transaction.actions].reverse()) {
      if (['pending', 'not-applied'].includes(entry.state)) {
        entry.state = 'not-applied';
        persistTransaction(transactionRoot, transaction);
        continue;
      }
      const { destination, currentSha256, beforeBytes } = validateRollbackEntry(projectRoot, transactionRoot, entry);
      if (currentSha256 === entry.beforeSha256) {
        entry.state = 'restored';
        persistTransaction(transactionRoot, transaction);
        continue;
      }
      if (entry.beforeSha256 === null) {
        fs.rmSync(destination, { force: true });
      } else {
        atomicWrite(destination, beforeBytes);
      }
      entry.state = 'restored';
      persistTransaction(transactionRoot, transaction);
    }
    transaction.status = 'rolled-back';
    transaction.rolledBackAt = new Date().toISOString();
    persistTransaction(transactionRoot, transaction);
  } catch (error) {
    transaction.status = 'rollback-required';
    transaction.rollbackDiagnostic = distributionFailureEvidence(error, 'rollback').classification.reason;
    try { persistTransaction(transactionRoot, transaction); }
    catch {
      throw retainDistributionFailure(error, { stage: 'rollback', transactionId: transaction.transactionId,
        write: 'partial-output', rollback: 'failed', cleanup: 'transaction-record-write-failed' });
    }
    throw error;
  }
};

export const applyDistributionPlan = ({ projectRoot, planPath, approvalDigest, beforeWrite }) => {
  const resolvedPlan = path.resolve(planPath);
  regularFile(resolvedPlan, 'distribution-plan-not-regular');
  const plan = readJson(resolvedPlan);
  if (plan.kind !== PLAN_KIND || plan.planDigest !== approvalDigest
    || sha256(jsonBytes(Object.fromEntries(Object.entries(plan).filter(([key]) => key !== 'planDigest')))) !== plan.planDigest) {
    throw new DistributionError('distribution-plan-approval-invalid');
  }
  if (plan.actions.some((entry) => entry.action === 'conflict')) {
    throw new DistributionError('distribution-plan-has-conflicts');
  }
  const stateRoot = path.resolve(projectRoot, '.a3-skills/ci-github');
  assertResolvedInside(projectRoot, stateRoot, 'distribution-state-root-outside-project');
  const lockPath = path.join(stateRoot, 'apply.lock');
  const lockHandle = acquireMutationLock(lockPath);
  let transactionRoot;
  let transaction;
  let primaryFailure;
  try {
    const transactionId = `${Date.now()}-${plan.planDigest.slice(0, 12)}`;
    const transactionsRoot = path.join(stateRoot, 'transactions');
    ensureDirectoryInside(projectRoot, transactionsRoot, 'distribution-transaction-root-outside-project');
    transactionRoot = path.join(transactionsRoot, transactionId);
    assertResolvedInside(projectRoot, transactionRoot, 'distribution-transaction-root-outside-project');
    fs.mkdirSync(transactionRoot, { recursive: false });
    transaction = {
      schemaVersion: '1',
      kind: TRANSACTION_KIND,
      transactionId,
      planDigest: plan.planDigest,
      sourceRevision: plan.sourceRevision,
      status: 'preparing',
      actions: [],
    };
    const loaded = loadFetchedDistribution(projectRoot, plan.sourceRevision);
    if (loaded.receipt.manifestSha256 !== plan.manifestSha256) {
      throw new DistributionError('distribution-plan-manifest-changed');
    }
    const assetLockPath = path.resolve(projectRoot, '.ci/ci-assets.lock.json');
    const currentAssetLockSha256 = digestIfFile(assetLockPath);
    if (!plan.priorAssetLock || plan.priorAssetLock.exists !== (currentAssetLockSha256 !== null)
      || plan.priorAssetLock.sha256 !== currentAssetLockSha256) {
      throw new DistributionError('distribution-plan-ownership-changed');
    }
    const prepared = new Map();
    for (const entry of plan.actions) {
      const source = inside(loaded.root, entry.sourcePath);
      const destination = inside(projectRoot, entry.destination);
      assertResolvedInside(projectRoot, destination, `distribution-destination-outside-root:${entry.destination}`);
      const sourceBytes = fs.readFileSync(source);
      if (sha256(sourceBytes) !== entry.sourceSha256
        || digestIfFile(destination) !== entry.destinationSha256) {
        throw new DistributionError(`distribution-plan-input-changed:${entry.destination}`);
      }
      if (prepared.has(entry.destination)) {
        throw new DistributionError(`distribution-plan-destination-duplicate:${entry.destination}`);
      }
      const generatedBytes = entry.generatedContent === undefined ? sourceBytes : Buffer.from(entry.generatedContent);
      if (sha256(generatedBytes) !== entry.generatedSha256) throw new DistributionError(`distribution-generated-content-changed:${entry.destination}`);
      prepared.set(entry.destination, generatedBytes);
      if (entry.action === 'reuse') continue;
      transaction.actions.push({
        destination: entry.destination,
        beforeSha256: entry.destinationSha256,
        afterSha256: entry.generatedSha256,
        state: 'pending',
      });
    }
    for (const entry of transaction.actions) {
      if (entry.beforeSha256 === null) continue;
      const destination = inside(projectRoot, entry.destination);
      assertResolvedInside(projectRoot, destination, `distribution-destination-outside-root:${entry.destination}`);
      const beforeBytes = fs.readFileSync(destination);
      if (sha256(beforeBytes) !== entry.beforeSha256) {
        throw new DistributionError(`distribution-plan-input-changed:${entry.destination}`);
      }
      const backup = inside(transactionRoot, `before/${entry.destination}`);
      assertResolvedInside(transactionRoot, backup, `distribution-backup-outside-transaction:${entry.destination}`);
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.writeFileSync(backup, beforeBytes, { flag: 'wx' });
    }
    transaction.status = 'applying';
    persistTransaction(transactionRoot, transaction);
    for (const [index, entry] of transaction.actions.entries()) {
      if (typeof beforeWrite === 'function') beforeWrite({ entry: { ...entry }, index });
      const destination = inside(projectRoot, entry.destination);
      assertResolvedInside(projectRoot, destination, `distribution-destination-outside-root:${entry.destination}`);
      if (digestIfFile(destination) !== entry.beforeSha256) {
        throw new DistributionError(`distribution-plan-input-changed:${entry.destination}`);
      }
      entry.state = 'writing';
      persistTransaction(transactionRoot, transaction);
      atomicWrite(destination, prepared.get(entry.destination));
      entry.state = 'applied';
      persistTransaction(transactionRoot, transaction);
    }
    transaction.status = 'applied';
    persistTransaction(transactionRoot, transaction);
    return {
      schemaVersion: '1',
      kind: 'a3-ci-github-distribution-apply-result',
      sourceRevision: plan.sourceRevision,
      planDigest: plan.planDigest,
      transactionId,
      status: 'applied',
      nextSteps: ['generate-asset-lock', 'lint', 'preflight', 'consumer-contract-tests'],
    };
  } catch (error) {
    if (transactionRoot && transaction && fs.existsSync(path.join(transactionRoot, 'transaction.json'))) {
      transaction.diagnostic = distributionFailureEvidence(error, 'apply').classification.reason;
      try {
        restoreTransaction(projectRoot, transactionRoot, transaction);
      } catch (rollbackError) {
        primaryFailure = new DistributionError('distribution-apply-rollback-failed', { cause: error, diagnostics: { stage: 'rollback', transactionId: transaction.transactionId, sourceRevision: plan.sourceRevision, write: 'partial-output', rollback: 'failed', input: 'transaction-state' } });
        throw primaryFailure;
      }
    }
    const captured = error instanceof DistributionError ? error : new DistributionError('distribution-unknown-failure', { cause: error });
    captured.details = { ...captured.details, stage: 'apply', transactionId: transaction?.transactionId ?? 'unavailable', sourceRevision: plan.sourceRevision, write: transaction ? transaction.status : 'not-started', rollback: transaction?.rollbackStatus ?? (transaction?.status === 'rolled-back' ? 'restored' : 'unavailable'), input: 'plan-and-transaction-state' };
    primaryFailure = captured;
    throw primaryFailure;
  } finally {
    try {
      releaseMutationLock(lockHandle, lockPath);
    } catch (cleanupError) {
      if (primaryFailure) primaryFailure.details = { ...primaryFailure.details, ...cleanupError.details };
      else throw retainDistributionFailure(cleanupError, { stage: 'lock-cleanup', transactionId: transaction?.transactionId,
        sourceRevision: plan.sourceRevision, write: 'applied', rollback: 'not-required' });
    }
  }
};

export const rollbackDistributionTransaction = ({ projectRoot, transactionId }) => {
  if (!/^[0-9]+-[0-9a-f]{12}$/.test(transactionId)) throw new DistributionError('distribution-transaction-id-invalid');
  const stateRoot = path.resolve(projectRoot, '.a3-skills/ci-github');
  assertResolvedInside(projectRoot, stateRoot, 'distribution-state-root-outside-project');
  const lockPath = path.join(stateRoot, 'apply.lock');
  const lockHandle = acquireMutationLock(lockPath);
  let primaryFailure;
  let failed = false;
  let transaction;
  try {
    const transactionRoot = path.join(stateRoot, 'transactions', transactionId);
    assertResolvedInside(projectRoot, transactionRoot, 'distribution-transaction-root-outside-project');
    const transactionPath = path.join(transactionRoot, 'transaction.json');
    regularFile(transactionPath, 'distribution-transaction-missing');
    transaction = readJson(transactionPath);
    if (transaction.kind !== TRANSACTION_KIND
      || !['applying', 'applied', 'rolling-back', 'rollback-required'].includes(transaction.status)) {
      throw new DistributionError('distribution-transaction-not-rollbackable');
    }
    restoreTransaction(projectRoot, transactionRoot, transaction);
    return { transactionId, status: 'rolled-back', rollbackStatus: 'restored' };
  } catch (error) {
    failed = true;
    primaryFailure = error;
    throw error;
  } finally {
    try { releaseMutationLock(lockHandle, lockPath); }
    catch (cleanupError) {
      const primaryDetails = failed && primaryFailure instanceof DistributionError ? primaryFailure.details : undefined;
      throw retainDistributionFailure(failed ? primaryFailure : cleanupError, {
        stage: failed ? 'rollback' : 'lock-cleanup', transactionId, input: 'transaction-state',
        write: transaction?.status ?? 'not-started', rollback: transaction?.status === 'rolled-back' ? 'restored' : 'unavailable',
        ...primaryDetails,
        ...cleanupError.details,
        ...(primaryDetails?.cleanup ? { priorCleanup: primaryDetails.cleanup } : {}),
      });
    }
  }
};

const parseCli = (argv) => {
  const command = argv[0];
  const commandFlags = {
    fetch: ['--repo-root', '--manifest', '--manifest-url', '--preset', '--asset', '--source-root'],
    verify: ['--repo-root', '--source-revision'],
    plan: ['--repo-root', '--source-revision', '--preset', '--asset', '--set'],
    apply: ['--repo-root', '--plan', '--approve'],
    rollback: ['--repo-root', '--transaction'],
  };
  if (!Object.hasOwn(commandFlags, command)) throw new DistributionError('distribution-command-unknown');
  const result = { command, presets: [], assets: [], settingInputs: [], settings: {}, projectRoot: '.', sourceRevision: '', planPath: '', approvalDigest: '', transactionId: '', manifestPath: '', manifestUrl: '', sourceRoot: '' };
  const repeatable = new Set(['--preset', '--asset', '--set']);
  const values = {
    '--repo-root': 'projectRoot', '--source-revision': 'sourceRevision', '--plan': 'planPath',
    '--approve': 'approvalDigest', '--transaction': 'transactionId', '--manifest': 'manifestPath',
    '--manifest-url': 'manifestUrl', '--source-root': 'sourceRoot', '--preset': 'presets', '--asset': 'assets',
    '--set': 'settingInputs',
  };
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!commandFlags[command].includes(flag) || !value || value.startsWith('--')) throw new DistributionError(`distribution-cli-argument-invalid:${flag}`);
    if (repeatable.has(flag)) result[values[flag]].push(value);
    else result[values[flag]] = value;
  }
  for (const entry of result.settingInputs) {
    const match = entry.match(/^(workflow\.[a-z0-9-]+):([a-zA-Z][a-zA-Z0-9._-]*)=(.*)$/s);
    if (!match) throw new DistributionError('distribution-setting-input-invalid');
    const [, assetId, key, encoded] = match;
    result.settings[assetId] ??= {};
    if (Object.hasOwn(result.settings[assetId], key)) throw new DistributionError(`distribution-setting-duplicate:${assetId}:${key}`);
    result.settings[assetId][key] = JSON.parse(encoded);
  }
  return result;
};

const main = async () => {
  const options = parseCli(process.argv.slice(2));
  if (options.command === 'fetch') {
    if (options.sourceRoot && !options.manifestPath) throw new DistributionError('distribution-local-source-requires-local-manifest');
    const loaded = await loadDistributionManifest({ manifestPath: options.manifestPath, manifestUrl: options.manifestUrl });
    return fetchDistribution({
      projectRoot: options.projectRoot,
      manifest: loaded.manifest,
      manifestBytes: loaded.bytes,
      requestedPresets: options.presets,
      requestedAssets: options.assets,
      sourceRoot: options.sourceRoot || undefined,
    });
  }
  if (options.command === 'verify') {
    if (!options.sourceRevision) throw new DistributionError('distribution-source-revision-required');
    return verifyFetchedDistribution({ projectRoot: options.projectRoot, sourceRevision: options.sourceRevision });
  }
  if (options.command === 'plan') {
    if (!options.sourceRevision) throw new DistributionError('distribution-source-revision-required');
    return planDistributionApplication({
    projectRoot: options.projectRoot,
    sourceRevision: options.sourceRevision,
    requestedPresets: options.presets,
    requestedAssets: options.assets,
    settings: options.settings,
    });
  }
  if (options.command === 'apply') {
    if (!options.planPath || !options.approvalDigest) throw new DistributionError('distribution-plan-and-approval-required');
    return applyDistributionPlan({
    projectRoot: options.projectRoot,
    planPath: options.planPath,
    approvalDigest: options.approvalDigest,
    });
  }
  if (options.command === 'rollback') {
    if (!options.transactionId) throw new DistributionError('distribution-transaction-required');
    return rollbackDistributionTransaction({
    projectRoot: options.projectRoot,
    transactionId: options.transactionId,
    });
  }
  throw new DistributionError('distribution-command-unknown');
};

const isDirectExecution = (() => {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isDirectExecution) {
  main().then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.exitCode = 2;
    try { process.stderr.write(`${JSON.stringify({
      schemaVersion: '1',
      kind: 'a3-ci-github-distribution-diagnostic',
      diagnostic: error instanceof DistributionError && /^distribution-cli-argument-invalid:--(?:source-revision|repo-root|source-root|manifest|manifest-url|preset|asset|plan|approve|approval-digest|transaction|setting|set|migration-inventory)$/.test(error.message) ? error.message : distributionFailureEvidence(error, ['fetch', 'verify', 'plan', 'apply', 'rollback'].includes(process.argv[2]) ? process.argv[2] : 'input-validation').classification.reason,
      failureEvidence: distributionFailureEvidence(error, ['fetch', 'verify', 'plan', 'apply', 'rollback'].includes(process.argv[2]) ? process.argv[2] : 'input-validation'),
    })}\n`); } catch { /* Retain the original result if diagnostic construction or output fails. */ }
  });
}
