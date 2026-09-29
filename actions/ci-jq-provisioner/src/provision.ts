import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  downloadVerifiedAsset,
  exportDirectoryToPath,
  type ProvisionRequest,
} from '../../../runtime/provisioner/provision-core.js';

export type { ProvisionRequest };

const FAILURE_PREFIX = 'jq-provision-failed';

export function selectAsset(runnerOs: string, runnerArch: string): string {
  const assets: Record<string, Record<string, string>> = {
    Linux: { X64: 'jq-linux-amd64', ARM64: 'jq-linux-arm64' },
    macOS: { X64: 'jq-macos-amd64', ARM64: 'jq-macos-arm64' },
    Windows: { X64: 'jq-windows-amd64.exe' },
  };
  const asset = assets[runnerOs]?.[runnerArch];
  if (!asset) throw new Error(`${FAILURE_PREFIX}: unsupported runner ${runnerOs}/${runnerArch}`);
  return asset;
}

export async function provisionJq(request: ProvisionRequest): Promise<string> {
  const { version, runnerOs, runnerArch, tempRoot, fetchAsset } = request;
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(version)) {
    throw new Error(`${FAILURE_PREFIX}: invalid exact version`);
  }
  const asset = selectAsset(runnerOs, runnerArch);
  const releaseUrl = `https://github.com/jqlang/jq/releases/download/jq-${version}`;
  const binary = await downloadVerifiedAsset({
    fetchAsset,
    checksumUrl: `${releaseUrl}/sha256sum.txt`,
    assetUrl: `${releaseUrl}/${asset}`,
    asset,
    failurePrefix: FAILURE_PREFIX,
  });

  let directory: string;
  try {
    directory = await mkdtemp(path.join(tempRoot, 'ci-jq-'));
  } catch (error) {
    throw new Error(`${FAILURE_PREFIX}: install: ${String(error)}`);
  }
  const installed = path.join(directory, runnerOs === 'Windows' ? 'jq.exe' : 'jq');
  try {
    await writeFile(installed, binary, { mode: 0o700 });
    if (runnerOs !== 'Windows') await chmod(installed, 0o755);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw new Error(`${FAILURE_PREFIX}: install: ${String(error)}`);
  }
  return installed;
}

export async function provisionJqOnPath(request: ProvisionRequest, githubPath: string): Promise<string> {
  const installed = await provisionJq(request);
  return exportDirectoryToPath(installed, githubPath, FAILURE_PREFIX);
}
