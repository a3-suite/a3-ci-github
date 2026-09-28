import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { existsSync, linkSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { pathsReferToSameFile } from '../same-file-core.mjs';

const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'a3-path-core-'));
after(() => {
  rmSync(temporaryRoot, { recursive: true, force: true });
  assert.equal(existsSync(temporaryRoot), false);
});
const invalidCode = 'same-file-test-invalid';

test('treats the same resolved path as one file', () => {
  const file = path.join(temporaryRoot, 'same.txt');
  writeFileSync(file, 'same');
  assert.equal(pathsReferToSameFile(file, file, invalidCode), true);
  assert.equal(pathsReferToSameFile(file, path.join(temporaryRoot, '.', 'same.txt'), invalidCode), true);
});

test('distinguishes different and non-existent paths', () => {
  const left = path.join(temporaryRoot, 'left.txt');
  const right = path.join(temporaryRoot, 'right.txt');
  writeFileSync(left, 'left');
  writeFileSync(right, 'right');
  assert.equal(pathsReferToSameFile(left, right, invalidCode), false);
  assert.equal(pathsReferToSameFile(
    path.join(temporaryRoot, 'missing-a.txt'),
    path.join(temporaryRoot, 'missing-b.txt'),
    invalidCode,
  ), false);
  assert.equal(pathsReferToSameFile(left, path.join(temporaryRoot, 'missing.txt'), invalidCode), false);
});

test('treats hard links to one inode as the same file', () => {
  const original = path.join(temporaryRoot, 'original.txt');
  const hardlink = path.join(temporaryRoot, 'hardlink.txt');
  writeFileSync(original, 'hardlink');
  linkSync(original, hardlink);
  assert.equal(pathsReferToSameFile(original, hardlink, invalidCode), true);
});

test('requires an explicit error code', () => {
  assert.throws(() => pathsReferToSameFile('left', 'right'), /same-file-invalid-code/);
  assert.throws(() => pathsReferToSameFile('left', 'right', ''), /same-file-invalid-code/);
});
