import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { describe, afterAll as after, test, expect } from 'vitest';
import { provisionJq, provisionJqOnPath, selectAsset } from '../src/provision.js';

const ownedTemporaryPaths: string[] = [];
async function testTempRoot(): Promise<string> {
  const parent = path.resolve('tests/tmp');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'ci-jq-provision-'));
  ownedTemporaryPaths.push(root);
  return root;
}
after(async () => {
  for (const root of ownedTemporaryPaths) await rm(root, { recursive: true });
});

describe('jq provisioning', () => {
  test('selects the supported runner assets', () => {
    expect(selectAsset('Linux', 'X64')).toBe('jq-linux-amd64');
    expect(selectAsset('Linux', 'ARM64')).toBe('jq-linux-arm64');
    expect(selectAsset('macOS', 'ARM64')).toBe('jq-macos-arm64');
    expect(selectAsset('Windows', 'X64')).toBe('jq-windows-amd64.exe');
    expect(() => selectAsset('Windows', 'ARM64')).toThrow(/jq-provision-failed/);
  });

  test('rejects an unsupported runner before download or PATH handoff', async () => {
    const tempRoot = await testTempRoot();
    const githubPath = path.join(tempRoot, 'github-path');
    await expect(() => provisionJqOnPath({
      version: '1.7.1', runnerOs: 'Windows', runnerArch: 'ARM64', tempRoot,
      fetchAsset: async () => { throw new Error('unexpected download'); },
    }, githubPath)).rejects.toThrow(/jq-provision-failed: unsupported runner/);
    await expect(() => readFile(githubPath)).rejects.toThrow(/ENOENT/);
  });

  test('installs the checksummed asset and exports its directory', async () => {
    const tempRoot = await testTempRoot();
    const binary = Buffer.from('jq fixture');
    const digest = createHash('sha256').update(binary).digest('hex');
    const requested: string[] = [];
    const fetchAsset = async (url: string): Promise<Buffer> => {
      requested.push(url);
      return url.endsWith('/sha256sum.txt')
        ? Buffer.from(`${digest}  jq-linux-amd64\n`)
        : binary;
    };
    const githubPath = path.join(tempRoot, 'github-path');
    const installed = await provisionJqOnPath({
      version: '1.7.1', runnerOs: 'Linux', runnerArch: 'X64',
      tempRoot, fetchAsset,
    }, githubPath);
    expect((await readFile(installed)).toString()).toBe('jq fixture');
    expect((await stat(installed)).mode & 0o111).toBe(0o111);
    expect((await readFile(githubPath, 'utf8')).trim()).toBe(path.dirname(installed));
    expect(requested).toStrictEqual([
      'https://github.com/jqlang/jq/releases/download/jq-1.7.1/sha256sum.txt',
      'https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq-linux-amd64',
    ]);
  });

  test('rejects a checksum mismatch without exposing a binary', async () => {
    const tempRoot = await testTempRoot();
    await expect(() => provisionJq({
      version: '1.7.1', runnerOs: 'Linux', runnerArch: 'X64', tempRoot,
      fetchAsset: async (url) => url.endsWith('/sha256sum.txt')
        ? Buffer.from(`${'0'.repeat(64)}  jq-linux-amd64\n`)
        : Buffer.from('jq fixture'),
    })).rejects.toThrow(/jq-provision-failed: checksum mismatch/);
  });

  test('reports a download failure separately from version verification', async () => {
    const tempRoot = await testTempRoot();
    const githubPath = path.join(tempRoot, 'github-path');
    await expect(() => provisionJqOnPath({
      version: '1.7.1', runnerOs: 'Linux', runnerArch: 'X64', tempRoot,
      fetchAsset: async () => { throw new Error('HTTP 404'); },
    }, githubPath)).rejects.toThrow(/jq-provision-failed: download: Error: HTTP 404/);
    await expect(() => readFile(githubPath)).rejects.toThrow(/ENOENT/);
  });

  test('rejects missing or duplicate checksum entries', async () => {
    for (const manifest of ['', `${'0'.repeat(64)}  jq-linux-amd64\n${'0'.repeat(64)}  jq-linux-amd64\n`]) {
      const tempRoot = await testTempRoot();
      await expect(() => provisionJq({
        version: '1.7.1', runnerOs: 'Linux', runnerArch: 'X64', tempRoot,
        fetchAsset: async (url) => url.endsWith('/sha256sum.txt')
          ? Buffer.from(manifest)
          : Buffer.from('jq fixture'),
      })).rejects.toThrow(/jq-provision-failed: checksum entry/);
    }
  });

  test('rejects an installation failure before PATH handoff', async () => {
    const tempRoot = await testTempRoot();
    const missingRoot = path.join(tempRoot, 'missing');
    const githubPath = path.join(tempRoot, 'github-path');
    const binary = Buffer.from('jq fixture');
    const digest = createHash('sha256').update(binary).digest('hex');
    await expect(() => provisionJqOnPath({
      version: '1.7.1', runnerOs: 'Linux', runnerArch: 'X64', tempRoot: missingRoot,
      fetchAsset: async (url) => url.endsWith('/sha256sum.txt')
        ? Buffer.from(`${digest}  jq-linux-amd64\n`)
        : binary,
    }, githubPath)).rejects.toThrow(/jq-provision-failed: install/);
    await expect(() => readFile(githubPath)).rejects.toThrow(/ENOENT/);
  });

  test('removes the installed binary when PATH update fails', async () => {
    const tempRoot = await testTempRoot();
    const binary = Buffer.from('jq fixture');
    const digest = createHash('sha256').update(binary).digest('hex');
    await expect(() => provisionJqOnPath({
      version: '1.7.1', runnerOs: 'Linux', runnerArch: 'X64', tempRoot,
      fetchAsset: async (url) => url.endsWith('/sha256sum.txt')
        ? Buffer.from(`${digest}  jq-linux-amd64\n`)
        : binary,
    }, tempRoot)).rejects.toThrow(/jq-provision-failed: PATH update/);
    expect(await readdir(tempRoot)).toStrictEqual([]);
  });
});
