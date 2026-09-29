import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';
import {
  downloadVerifiedAsset,
  exportDirectoryToPath,
  selectChecksumDigest,
  sha256Hex,
  verifySha256,
} from '../provision-core.js';

const ownedTemporaryPaths: string[] = [];
async function testTempRoot(): Promise<string> {
  const parent = path.resolve('tests/tmp');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'provision-core-'));
  ownedTemporaryPaths.push(root);
  return root;
}
after(async () => {
  for (const root of ownedTemporaryPaths) await rm(root, { recursive: true });
});

const prefix = 'provision-failed';
const asset = 'tool-linux-amd64';
const digestOf = (content: string): string => sha256Hex(Buffer.from(content));

test('selects the single matching checksum entry', () => {
  for (const manifest of [
    `${'0'.repeat(64)}  other\n${digestOf('tool')} *${asset}\n`,
    `${'0'.repeat(64)}  other\r\n${digestOf('tool')}  ${asset}\r\n`,
  ]) {
    assert.equal(selectChecksumDigest(manifest, asset, prefix), digestOf('tool'));
  }
});

test('rejects missing and duplicate checksum entries', () => {
  const entry = `${digestOf('tool')}  ${asset}`;
  for (const manifest of ['', `${entry}\n${entry}\n`, `${'0'.repeat(64)}  other\n`]) {
    assert.throws(
      () => selectChecksumDigest(manifest, asset, prefix),
      new RegExp(`${prefix}: checksum entry for ${asset} must occur once`),
    );
  }
});

test('verifies a matching sha256 digest and rejects a mismatch', () => {
  assert.equal(sha256Hex(Buffer.from('tool')), digestOf('tool'));
  assert.doesNotThrow(() => verifySha256(Buffer.from('tool'), digestOf('tool'), asset, prefix));
  assert.throws(
    () => verifySha256(Buffer.from('tampered'), digestOf('tool'), asset, prefix),
    new RegExp(`${prefix}: checksum mismatch for ${asset}`),
  );
});

test('downloads checksums before the asset and returns verified content', async () => {
  const requested: string[] = [];
  const content = Buffer.from('tool');
  const result = await downloadVerifiedAsset({
    fetchAsset: async (url) => {
      requested.push(url);
      return url === 'checksums' ? Buffer.from(`${digestOf('tool')}  ${asset}\n`) : content;
    },
    checksumUrl: 'checksums',
    assetUrl: 'asset',
    asset,
    failurePrefix: prefix,
  });
  assert.equal(result, content);
  assert.deepEqual(requested, ['checksums', 'asset']);
});

test('wraps a download failure with the tool prefix', async () => {
  await assert.rejects(() => downloadVerifiedAsset({
    fetchAsset: async () => { throw new Error('HTTP 404'); },
    checksumUrl: 'checksums',
    assetUrl: 'asset',
    asset,
    failurePrefix: prefix,
  }), new RegExp(`${prefix}: download: Error: HTTP 404`));
});

test('rejects a checksum mismatch before returning content', async () => {
  await assert.rejects(() => downloadVerifiedAsset({
    fetchAsset: async (url) => url === 'checksums'
      ? Buffer.from(`${'0'.repeat(64)}  ${asset}\n`)
      : Buffer.from('tool'),
    checksumUrl: 'checksums',
    assetUrl: 'asset',
    asset,
    failurePrefix: prefix,
  }), new RegExp(`${prefix}: checksum mismatch for ${asset}`));
});

test('appends the installed directory to the path file', async () => {
  const tempRoot = await testTempRoot();
  const githubPath = path.join(tempRoot, 'github-path');
  const directory = await mkdtemp(path.join(tempRoot, 'installed-'));
  const installed = path.join(directory, 'tool');
  assert.equal(await exportDirectoryToPath(installed, githubPath, prefix), installed);
  assert.equal(await readFile(githubPath, 'utf8'), `${directory}\n`);
});

test('removes the installed directory when the path handoff fails', async () => {
  const tempRoot = await testTempRoot();
  const directory = await mkdtemp(path.join(tempRoot, 'installed-'));
  await assert.rejects(
    () => exportDirectoryToPath(path.join(directory, 'tool'), tempRoot, prefix),
    new RegExp(`${prefix}: PATH update`),
  );
  assert.deepEqual(await readdir(tempRoot), []);
});
