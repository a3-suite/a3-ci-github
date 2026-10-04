import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { describe, afterAll as after, test, expect } from 'vitest';
import { provisionGh, provisionGhOnPath, selectAsset } from '../src/provision.js';

const ownedTemporaryPaths: string[] = [];
async function testTempRoot(): Promise<string> {
  const parent = path.resolve('tests/tmp');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'ci-gh-provision-'));
  ownedTemporaryPaths.push(root);
  return root;
}
after(async () => {
  for (const root of ownedTemporaryPaths) await rm(root, { recursive: true });
});

const fixtureVersion = '2.80.0';
const fixtureAsset = 'gh_2.80.0_linux_amd64.tar.gz';
const fixtureMember = 'gh_2.80.0_linux_amd64/bin/gh';

function buildArchive(root: string, member: string, content: Buffer): Buffer {
  const staging = path.join(root, 'staging');
  mkdirSync(path.join(staging, path.dirname(member)), { recursive: true });
  writeFileSync(path.join(staging, member), content);
  const archivePath = path.join(root, 'fixture.tar.gz');
  execFileSync('tar', ['-czf', archivePath, '-C', staging, member.split('/')[0]!]);
  return readFileSync(archivePath);
}

function fixtureFetch(archive: Buffer): (url: string) => Promise<Buffer> {
  const digest = createHash('sha256').update(archive).digest('hex');
  return async (url) => {
    if (url.endsWith(`/${fixtureAsset}`)) return archive;
    return Buffer.from(`${digest}  ${fixtureAsset}\n`);
  };
}

describe('GitHub CLI provisioning', () => {
  test('selects the supported runner assets', () => {
    expect(selectAsset(fixtureVersion, 'Linux', 'X64')).toBe(fixtureAsset);
    expect(selectAsset(fixtureVersion, 'Linux', 'ARM64')).toBe('gh_2.80.0_linux_arm64.tar.gz');
    expect(() => selectAsset(fixtureVersion, 'macOS', 'ARM64')).toThrow(/gh-provision-failed/);
    expect(() => selectAsset(fixtureVersion, 'Windows', 'X64')).toThrow(/gh-provision-failed/);
  });

  test('rejects an unsupported runner before download or PATH handoff', async () => {
    const tempRoot = await testTempRoot();
    const githubPath = path.join(tempRoot, 'github-path');
    await expect(() => provisionGhOnPath({
      version: fixtureVersion, runnerOs: 'Windows', runnerArch: 'X64', tempRoot,
      fetchAsset: async () => { throw new Error('unexpected download'); },
    }, githubPath)).rejects.toThrow(/gh-provision-failed: unsupported runner/);
    await expect(() => readFile(githubPath)).rejects.toThrow(/ENOENT/);
  });

  test('installs the checksummed asset and exports its directory', async () => {
    const tempRoot = await testTempRoot();
    const archive = buildArchive(tempRoot, fixtureMember, Buffer.from('gh fixture'));
    const requested: string[] = [];
    const fetchAsset = fixtureFetch(archive);
    const githubPath = path.join(tempRoot, 'github-path');
    const installed = await provisionGhOnPath({
      version: fixtureVersion, runnerOs: 'Linux', runnerArch: 'X64', tempRoot,
      fetchAsset: async (url) => {
        requested.push(url);
        return fetchAsset(url);
      },
    }, githubPath);
    expect((await readFile(installed)).toString()).toBe('gh fixture');
    expect((await stat(installed)).mode & 0o111).toBe(0o111);
    expect((await readFile(githubPath, 'utf8')).trim()).toBe(path.dirname(installed));
    expect(await readdir(path.dirname(installed))).toStrictEqual(['gh']);
    expect(requested).toStrictEqual([
      `https://github.com/cli/cli/releases/download/v${fixtureVersion}/gh_${fixtureVersion}_checksums.txt`,
      `https://github.com/cli/cli/releases/download/v${fixtureVersion}/${fixtureAsset}`,
    ]);
  });

  test('rejects a checksum mismatch without exposing a binary', async () => {
    const tempRoot = await testTempRoot();
    const archive = buildArchive(tempRoot, fixtureMember, Buffer.from('gh fixture'));
    await expect(() => provisionGh({
      version: fixtureVersion, runnerOs: 'Linux', runnerArch: 'X64', tempRoot,
      fetchAsset: async (url) => url.endsWith(`/${fixtureAsset}`)
        ? archive
        : Buffer.from(`${'0'.repeat(64)}  ${fixtureAsset}\n`),
    })).rejects.toThrow(/gh-provision-failed: checksum mismatch/);
    expect((await readdir(tempRoot)).filter((entry) => entry.startsWith('ci-gh-'))).toStrictEqual([]);
  });

  test('reports a download failure separately from version verification', async () => {
    const tempRoot = await testTempRoot();
    const githubPath = path.join(tempRoot, 'github-path');
    await expect(() => provisionGhOnPath({
      version: fixtureVersion, runnerOs: 'Linux', runnerArch: 'X64', tempRoot,
      fetchAsset: async () => { throw new Error('HTTP 404'); },
    }, githubPath)).rejects.toThrow(/gh-provision-failed: download: Error: HTTP 404/);
    await expect(() => readFile(githubPath)).rejects.toThrow(/ENOENT/);
  });

  test('rejects missing or duplicate checksum entries', async () => {
    for (const manifest of ['', `${'0'.repeat(64)}  ${fixtureAsset}\n${'0'.repeat(64)}  ${fixtureAsset}\n`]) {
      const tempRoot = await testTempRoot();
      const archive = buildArchive(tempRoot, fixtureMember, Buffer.from('gh fixture'));
      await expect(() => provisionGh({
        version: fixtureVersion, runnerOs: 'Linux', runnerArch: 'X64', tempRoot,
        fetchAsset: async (url) => url.endsWith(`/${fixtureAsset}`)
          ? archive
          : Buffer.from(manifest),
      })).rejects.toThrow(/gh-provision-failed: checksum entry/);
    }
  });

  test('rejects an extraction failure before PATH handoff', async () => {
    const tempRoot = await testTempRoot();
    const archive = Buffer.from('not an archive');
    const githubPath = path.join(tempRoot, 'github-path');
    await expect(() => provisionGhOnPath({
      version: fixtureVersion, runnerOs: 'Linux', runnerArch: 'X64', tempRoot,
      fetchAsset: fixtureFetch(archive),
    }, githubPath)).rejects.toThrow(/gh-provision-failed: install/);
    await expect(() => readFile(githubPath)).rejects.toThrow(/ENOENT/);
  });

  test('rejects an installation failure before PATH handoff', async () => {
    const tempRoot = await testTempRoot();
    const missingRoot = path.join(tempRoot, 'missing');
    const archive = buildArchive(tempRoot, fixtureMember, Buffer.from('gh fixture'));
    const githubPath = path.join(tempRoot, 'github-path');
    await expect(() => provisionGhOnPath({
      version: fixtureVersion, runnerOs: 'Linux', runnerArch: 'X64', tempRoot: missingRoot,
      fetchAsset: fixtureFetch(archive),
    }, githubPath)).rejects.toThrow(/gh-provision-failed: install/);
    await expect(() => readFile(githubPath)).rejects.toThrow(/ENOENT/);
  });

  test('removes the installed binary when PATH update fails', async () => {
    const tempRoot = await testTempRoot();
    const archive = buildArchive(tempRoot, fixtureMember, Buffer.from('gh fixture'));
    await expect(() => provisionGhOnPath({
      version: fixtureVersion, runnerOs: 'Linux', runnerArch: 'X64', tempRoot,
      fetchAsset: fixtureFetch(archive),
    }, tempRoot)).rejects.toThrow(/gh-provision-failed: PATH update/);
    expect((await readdir(tempRoot)).sort()).toStrictEqual(['fixture.tar.gz', 'staging']);
  });
});
