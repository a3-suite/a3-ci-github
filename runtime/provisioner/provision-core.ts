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
    throw new Error(`${failurePrefix}: checksum entry for ${asset} must occur once`);
  }
  return matches[0]![1];
}

export function verifySha256(content: Buffer, expected: string, asset: string, failurePrefix: string): void {
  if (sha256Hex(content) !== expected) {
    throw new Error(`${failurePrefix}: checksum mismatch for ${asset}`);
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
    throw new Error(`${failurePrefix}: download: ${String(error)}`);
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
    await rm(path.dirname(installed), { recursive: true, force: true });
    throw new Error(`${failurePrefix}: PATH update: ${String(error)}`);
  }
  return installed;
}
