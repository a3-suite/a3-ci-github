import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const LIMITS = Object.freeze({ jsonBytes: 1048576, assets: 256, assetBytes: 2147483648, totalBytes: 8589934592, pages: 100, responseBytes: 4194304, timeoutMs: 30000 });
export function fail(code: string): never { throw new Error(code); }
export const sha256 = (bytes: Uint8Array): string => crypto.createHash('sha256').update(bytes).digest('hex');
export const canonicalJson = (value: unknown): string => JSON.stringify(value, (_key: string, entry: unknown) => record(entry)
  ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]])) : entry);
export const equal = (left: unknown, right: unknown, code: string): void => { if (canonicalJson(left) !== canonicalJson(right)) fail(code); };
export const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export const text = (value: unknown, code = 'field-invalid'): string => {
  if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value)) fail(code);
  return value;
};
export const hex = (value: unknown, length = 64): string => {
  if (typeof value !== 'string' || !new RegExp(`^[a-f0-9]{${length}}$`).test(value)) fail('digest-or-source-invalid');
  return value;
};
export const assetName = (input: unknown): string => {
  const value = text(input);
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/.test(value) || value === '.' || value === '..') fail('asset-name-invalid');
  return value;
};
export const safePath = (root: string, input: unknown, directory = false): string => {
  const relative = text(input, 'path-invalid');
  if (relative.includes('\\') || path.isAbsolute(relative) || relative.split('/').some((part) => !part || part === '.' || part === '..')) fail('path-invalid');
  let current = path.resolve(root);
  if (fs.lstatSync(current).isSymbolicLink() || !fs.statSync(current).isDirectory()) fail('root-invalid');
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) fail('symlink-forbidden');
  }
  const stat = fs.statSync(current);
  if (directory ? !stat.isDirectory() : !stat.isFile()) fail('file-kind-invalid');
  return current;
};
export const readBytes = (filename: string, maximum: number = LIMITS.jsonBytes): Buffer => {
  if (fs.lstatSync(filename).isSymbolicLink() || !fs.statSync(filename).isFile()) fail('file-kind-invalid');
  const stat = fs.statSync(filename);
  if (stat.size === 0 || stat.size > maximum) fail('input-size-invalid');
  return fs.readFileSync(filename);
};
export const parseJson = (bytes: Buffer): unknown => {
  try { return JSON.parse(bytes.toString('utf8')); } catch { return fail('json-invalid'); }
};
export const readJson = (filename: string): unknown => parseJson(readBytes(filename));
export const hashFile = (filename: string, maximum: number = LIMITS.assetBytes, allowEmpty = false): string => {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || (!allowEmpty && stat.size === 0) || stat.size > maximum) fail('asset-size-or-kind-invalid');
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.alloc(1048576);
  try {
    let count;
    let total = 0;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      total += count;
      if (total > maximum) fail('asset-size-or-kind-invalid');
      hash.update(buffer.subarray(0, count));
    }
    if (total !== stat.size) fail('asset-changed-during-read');
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
};
export const releaseErrorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : '';
  // Unexpected platform/network errors must not disclose tokens, paths or signed redirects.
  return /^[a-z][a-z0-9-]+(?::[A-Za-z0-9_.\[\]-]+)?$/.test(message) || message.startsWith('remote-state-unknown:{') ? message : 'release-validation-failed';
};
export const readRecord = (filename: string): Record<string, unknown> => {
  const value = readJson(filename);
  if (!record(value)) fail('json-object-invalid');
  return value;
};
export const writeNewJson = (filename: string, value: unknown): void => fs.writeFileSync(filename, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
