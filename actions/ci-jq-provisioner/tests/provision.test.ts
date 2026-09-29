import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';
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

test('selects the supported runner assets', () => {
  assert.equal(selectAsset('Linux', 'X64'), 'jq-linux-amd64');
  assert.equal(selectAsset('Linux', 'ARM64'), 'jq-linux-arm64');
  assert.equal(selectAsset('macOS', 'ARM64'), 'jq-macos-arm64');
  assert.equal(selectAsset('Windows', 'X64'), 'jq-windows-amd64.exe');
  assert.throws(() => selectAsset('Windows', 'ARM64'), /jq-provision-failed/);
});

test('rejects an unsupported runner before download or PATH handoff', async () => {
  const tempRoot = await testTempRoot();
  const githubPath = path.join(tempRoot, 'github-path');
  await assert.rejects(() => provisionJqOnPath({
    version: '1.7.1', runnerOs: 'Windows', runnerArch: 'ARM64', tempRoot,
    fetchAsset: async () => { throw new Error('unexpected download'); },
  }, githubPath), /jq-provision-failed: unsupported runner/);
  await assert.rejects(() => readFile(githubPath), /ENOENT/);
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
  assert.equal((await readFile(installed)).toString(), 'jq fixture');
  assert.equal((await stat(installed)).mode & 0o111, 0o111);
  assert.equal((await readFile(githubPath, 'utf8')).trim(), path.dirname(installed));
  assert.deepEqual(requested, [
    'https://github.com/jqlang/jq/releases/download/jq-1.7.1/sha256sum.txt',
    'https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq-linux-amd64',
  ]);
});

test('rejects a checksum mismatch without exposing a binary', async () => {
  const tempRoot = await testTempRoot();
  await assert.rejects(() => provisionJq({
    version: '1.7.1', runnerOs: 'Linux', runnerArch: 'X64', tempRoot,
    fetchAsset: async (url) => url.endsWith('/sha256sum.txt')
      ? Buffer.from(`${'0'.repeat(64)}  jq-linux-amd64\n`)
      : Buffer.from('jq fixture'),
  }), /jq-provision-failed: checksum mismatch/);
});

test('reports a download failure separately from version verification', async () => {
  const tempRoot = await testTempRoot();
  const githubPath = path.join(tempRoot, 'github-path');
  await assert.rejects(() => provisionJqOnPath({
    version: '1.7.1', runnerOs: 'Linux', runnerArch: 'X64', tempRoot,
    fetchAsset: async () => { throw new Error('HTTP 404'); },
  }, githubPath), /jq-provision-failed: download: Error: HTTP 404/);
  await assert.rejects(() => readFile(githubPath), /ENOENT/);
});

test('rejects missing or duplicate checksum entries', async () => {
  for (const manifest of ['', `${'0'.repeat(64)}  jq-linux-amd64\n${'0'.repeat(64)}  jq-linux-amd64\n`]) {
    const tempRoot = await testTempRoot();
    await assert.rejects(() => provisionJq({
      version: '1.7.1', runnerOs: 'Linux', runnerArch: 'X64', tempRoot,
      fetchAsset: async (url) => url.endsWith('/sha256sum.txt')
        ? Buffer.from(manifest)
        : Buffer.from('jq fixture'),
    }), /jq-provision-failed: checksum entry/);
  }
});

test('rejects an installation failure before PATH handoff', async () => {
  const tempRoot = await testTempRoot();
  const missingRoot = path.join(tempRoot, 'missing');
  const githubPath = path.join(tempRoot, 'github-path');
  const binary = Buffer.from('jq fixture');
  const digest = createHash('sha256').update(binary).digest('hex');
  await assert.rejects(() => provisionJqOnPath({
    version: '1.7.1', runnerOs: 'Linux', runnerArch: 'X64', tempRoot: missingRoot,
    fetchAsset: async (url) => url.endsWith('/sha256sum.txt')
      ? Buffer.from(`${digest}  jq-linux-amd64\n`)
      : binary,
  }, githubPath), /jq-provision-failed: install/);
  await assert.rejects(() => readFile(githubPath), /ENOENT/);
});

test('removes the installed binary when PATH update fails', async () => {
  const tempRoot = await testTempRoot();
  const binary = Buffer.from('jq fixture');
  const digest = createHash('sha256').update(binary).digest('hex');
  await assert.rejects(() => provisionJqOnPath({
    version: '1.7.1', runnerOs: 'Linux', runnerArch: 'X64', tempRoot,
    fetchAsset: async (url) => url.endsWith('/sha256sum.txt')
      ? Buffer.from(`${digest}  jq-linux-amd64\n`)
      : binary,
  }, tempRoot), /jq-provision-failed: PATH update/);
  assert.deepEqual(await readdir(tempRoot), []);
});
