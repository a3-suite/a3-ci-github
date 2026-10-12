import { DiagnosticError } from '../diagnostics/failure.mjs';
import { createHash } from 'node:crypto';
import { appendFile, rm } from 'node:fs/promises';
import path from 'node:path';

export type FetchAsset = (url: string) => Promise<Buffer>;

export type ProvisionRequest = {
  version: string;
  runnerOs: string;
  runnerArch: string;
  tempRoot: string;
  fetchAsset: FetchAsset;
};

export function sha256Hex(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export function selectChecksumDigest(manifest: string, asset: string, failurePrefix: string): string {
  const matches = manifest.split(/\r?\n/).map((line) =>
    line.match(/^([0-9a-f]{64})\s+\*?([^\s]+)$/),
  ).filter((match) => match?.[2] === asset);
  if (matches.length !== 1) {
    throw new DiagnosticError(`${failurePrefix}: checksum entry for ${asset} must occur once`, { diagnostics: { stage: 'checksum-inventory', field: 'checksum-entry-count', asset, expected: 1, observed: matches.length } });
  }
  return matches[0]![1];
}

export function verifySha256(content: Buffer, expected: string, asset: string, failurePrefix: string): void {
  const observed = sha256Hex(content);
  if (observed !== expected) {
    throw new DiagnosticError(`${failurePrefix}: checksum mismatch for ${asset}`, { diagnostics: { stage: 'checksum-validation', field: 'sha256', asset, expected, observed } });
  }
}

export type VerifiedAssetRequest = {
  fetchAsset: FetchAsset;
  checksumUrl: string;
  assetUrl: string;
  asset: string;
  failurePrefix: string;
};

export async function downloadVerifiedAsset(request: VerifiedAssetRequest): Promise<Buffer> {
  const { fetchAsset, checksumUrl, assetUrl, asset, failurePrefix } = request;
  let manifest: Buffer;
  let content: Buffer;
  try {
    manifest = await fetchAsset(checksumUrl);
    content = await fetchAsset(assetUrl);
  } catch (error) {
    throw new DiagnosticError(`${failurePrefix}: download failed`, { cause: error, diagnostics: { stage: 'asset-download', field: 'provider-release-asset', asset, observed: 'download-failed', expected: 'complete-download', ...(error instanceof DiagnosticError && error.details && typeof error.details === 'object' ? error.details : {}) } });
  }
  const expected = selectChecksumDigest(manifest.toString('utf8'), asset, failurePrefix);
  verifySha256(content, expected, asset, failurePrefix);
  return content;
}

export async function exportDirectoryToPath(
  installed: string,
  githubPath: string,
  failurePrefix: string,
): Promise<string> {
  try {
    await appendFile(githubPath, `${path.dirname(installed)}\n`, 'utf8');
  } catch (error) {
    let rollback = 'removed';
    try { await rm(path.dirname(installed), { recursive: true, force: true }); } catch { rollback = 'cleanup-failed'; }
    throw new DiagnosticError(`${failurePrefix}: PATH update failed`, { cause: error, diagnostics: { stage: 'path-export', field: 'GITHUB_PATH', observed: 'write-failed', expected: 'append-installed-directory', rollback } });
  }
  return installed;
}
