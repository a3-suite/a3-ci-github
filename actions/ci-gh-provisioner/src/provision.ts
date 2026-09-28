import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  downloadVerifiedAsset,
  exportDirectoryToPath,
  type ProvisionRequest,
} from '../../../runtime/provisioner/provision-core.js';

export type { ProvisionRequest };

const FAILURE_PREFIX = 'gh-provision-failed';

export function selectAsset(version: string, runnerOs: string, runnerArch: string): string {
  const platforms: Record<string, Record<string, string>> = {
    Linux: { X64: 'linux_amd64', ARM64: 'linux_arm64' },
  };
  const platform = platforms[runnerOs]?.[runnerArch];
  if (!platform) throw new Error(`${FAILURE_PREFIX}: unsupported runner ${runnerOs}/${runnerArch}`);
  return `gh_${version}_${platform}.tar.gz`;
}

function extractMember(archivePath: string, destination: string, member: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('tar', ['-xzf', archivePath, '-C', destination, '--strip-components=2', member], (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function installGh(archive: Buffer, asset: string, tempRoot: string): Promise<string> {
  let directory: string;
  try {
    directory = await mkdtemp(path.join(tempRoot, 'ci-gh-'));
  } catch (error) {
    throw new Error(`${FAILURE_PREFIX}: install: ${String(error)}`);
  }
  const archivePath = path.join(directory, 'gh-release.tar.gz');
  const installed = path.join(directory, 'gh');
  try {
    await writeFile(archivePath, archive, { mode: 0o600 });
    await extractMember(archivePath, directory, `${asset.replace(/\.tar\.gz$/, '')}/bin/gh`);
    await chmod(installed, 0o755);
    await unlink(archivePath);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw new Error(`${FAILURE_PREFIX}: install: ${String(error)}`);
  }
  return installed;
}

export async function provisionGh(request: ProvisionRequest): Promise<string> {
  const { version, runnerOs, runnerArch, tempRoot, fetchAsset } = request;
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`${FAILURE_PREFIX}: invalid exact version`);
  }
  const asset = selectAsset(version, runnerOs, runnerArch);
  const releaseUrl = `https://github.com/cli/cli/releases/download/v${version}`;
  const archive = await downloadVerifiedAsset({
    fetchAsset,
    checksumUrl: `${releaseUrl}/gh_${version}_checksums.txt`,
    assetUrl: `${releaseUrl}/${asset}`,
    asset,
    failurePrefix: FAILURE_PREFIX,
  });

  return installGh(archive, asset, tempRoot);
}

export async function provisionGhOnPath(request: ProvisionRequest, githubPath: string): Promise<string> {
  const installed = await provisionGh(request);
  return exportDirectoryToPath(installed, githubPath, FAILURE_PREFIX);
}
