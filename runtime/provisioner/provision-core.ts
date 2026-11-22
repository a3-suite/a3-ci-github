import { DiagnosticError } from '../diagnostics/failure.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readFile, rename, rm } from 'node:fs/promises';
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
    // Settle both reads before returning, including when a fetcher throws synchronously.
    const [manifestResult, contentResult] = await Promise.allSettled(
      [checksumUrl, assetUrl].map((url) => Promise.resolve().then(() => fetchAsset(url))),
    );
    if (manifestResult.status === 'rejected') throw manifestResult.reason;
    if (contentResult.status === 'rejected') throw contentResult.reason;
    manifest = manifestResult.value;
    content = contentResult.value;
  } catch (error) {
    throw new DiagnosticError(`${failurePrefix}: download failed`, { cause: error, diagnostics: { stage: 'asset-download', field: 'provider-release-asset', asset, observed: 'download-failed', expected: 'complete-download', ...(error instanceof DiagnosticError && error.details && typeof error.details === 'object' ? error.details : {}) } });
  }
  const expected = selectChecksumDigest(manifest.toString('utf8'), asset, failurePrefix);
  verifySha256(content, expected, asset, failurePrefix);
  return content;
}

// A failed PATH export leaves the runner handoff unchanged. Its write state records install cleanup.
export function provisionWriteState(error: unknown): string {
  const details = error instanceof DiagnosticError && error.details && typeof error.details === 'object' ? error.details as { stage?: unknown; rollback?: unknown } : undefined;
  const rollback = details?.rollback;
  if (rollback === 'removed') return 'rolled-back';
  if (rollback === 'cleanup-failed') return 'temporary-install-may-exist';
  return 'not-started';
}

export async function exportDirectoryToPath(
  installed: string,
  githubPath: string,
  failurePrefix: string,
): Promise<string> {
  const temporary = path.join(path.dirname(githubPath), `.provision-path-${randomUUID()}`);
  let ownsTemporary = false;
  try {
    const current = await lstat(githubPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (current && !current.isFile()) throw new Error('PATH handoff must be a regular file');
    const prior = current ? await readFile(githubPath) : Buffer.alloc(0);
    const handle = await open(temporary, 'wx', current ? current.mode & 0o777 : 0o666);
    ownsTemporary = true;
    try {
      await handle.writeFile(Buffer.concat([prior, Buffer.from(`${path.dirname(installed)}\n`)]));
    } finally {
      await handle.close();
    }
    await rename(temporary, githubPath);
  } catch (error) {
    let rollback = 'removed';
    if (ownsTemporary) {
      try { await rm(temporary, { force: true }); } catch { rollback = 'cleanup-failed'; }
    }
    try { await rm(path.dirname(installed), { recursive: true, force: true }); } catch { rollback = 'cleanup-failed'; }
    throw new DiagnosticError(`${failurePrefix}: PATH update failed`, { cause: error, diagnostics: { stage: 'path-export', field: 'GITHUB_PATH', observed: 'write-failed', expected: 'append-installed-directory', rollback } });
  }
  return installed;
}
