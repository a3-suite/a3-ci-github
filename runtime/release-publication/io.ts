import { DiagnosticError } from '../diagnostics/failure.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import installerReasons from '../installer/src/diagnostic-reasons.json';

export const LIMITS = Object.freeze({ jsonBytes: 1048576, assets: 256, assetBytes: 2147483648, totalBytes: 8589934592, pages: 100, responseBytes: 4194304, timeoutMs: 30000 });
export function fail(code: string, diagnostics?: Record<string, unknown>): never { throw new DiagnosticError(code, { diagnostics }); }
export const sha256 = (bytes: Uint8Array): string => crypto.createHash('sha256').update(bytes).digest('hex');
export const canonicalJson = (value: unknown): string => JSON.stringify(value, (_key: string, entry: unknown) => record(entry)
  ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]])) : entry);
export const equal = (left: unknown, right: unknown, code: string, field = 'validated-public-identity'): void => {
  if (canonicalJson(left) !== canonicalJson(right)) fail(code, { field, expected_sha256: sha256(Buffer.from(canonicalJson(right))), observed_sha256: sha256(Buffer.from(canonicalJson(left))) });
};
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
export const installerFailureReasons: readonly string[] = installerReasons;
const diagnosticOperations = ['remote-observation', 'asset-readback', 'release-create', 'asset-upload', 'release-finalize', 'standard-installer', 'owner-adapter'];
const diagnosticPhases = ['request', 'response', 'repository', 'inventory', 'post-create', 'build-platform', 'assemble'];
const diagnosticReasons = ['provider-read-failed', 'provider-write-failed', 'provider-write-result-unknown', 'network-failed', 'request-timeout', 'response-empty', 'response-too-large', 'response-invalid-json', 'response-read-failed', 'redirect-missing', 'redirect-invalid', 'response-shape-invalid', 'remote-id-invalid', 'inventory-duplicate-id', 'pagination-limit', 'repository-identity-mismatch', 'permissions-missing', 'push-permission-missing', 'push-permission-denied', 'push-permission-invalid', 'release-not-visible', 'process-failed', 'process-start-failed', 'process-signaled', 'installer-unknown-failure', ...installerReasons];
export type DiagnosticType = {
  operation: string; phase: string; method?: string; 'sanitized-endpoint'?: string;
  'http-status'?: number | 'unavailable'; 'request-id'?: string; 'sanitized-reason': string;
  'exit-status'?: number | 'unavailable'; signal?: string;
  cleanup?: { status: 'failed'; 'temporary-state': 'unknown' };
  comparison?: { field: 'installer-candidate-files'; expected: string[]; observed: string[]; missing: string[]; extra: string[]; changed: string[] };
};
export const safeInstallerComparison = (value: unknown): value is NonNullable<DiagnosticType['comparison']> => record(value)
  && Object.keys(value).sort().join(',') === 'changed,expected,extra,field,missing,observed'
  && value.field === 'installer-candidate-files'
  && ['expected', 'observed', 'missing', 'extra', 'changed'].every((key) => Array.isArray(value[key])
    && value[key].length <= 256 && value[key].every((entry: unknown) => typeof entry === 'string' && /^[A-Za-z0-9._+-]{1,200}$/.test(entry)));
export const safeInstallerCleanup = (value: unknown): value is NonNullable<DiagnosticType['cleanup']> => record(value)
  && Object.keys(value).sort().join(',') === 'status,temporary-state'
  && value.status === 'failed' && value['temporary-state'] === 'unknown';
const safeDiagnostic = (value: unknown): value is DiagnosticType => {
  if (!record(value) || Object.keys(value).some((key) => !['operation', 'phase', 'method', 'sanitized-endpoint', 'http-status', 'request-id', 'sanitized-reason', 'exit-status', 'signal', 'comparison', 'cleanup'].includes(key))) return false;
  if (value.cleanup !== undefined && (value.operation !== 'standard-installer' || !safeInstallerCleanup(value.cleanup))) return false;
  if (value.comparison !== undefined && !safeInstallerComparison(value.comparison)) return false;
  if (typeof value.operation !== 'string' || typeof value.phase !== 'string' || typeof value['sanitized-reason'] !== 'string' || !diagnosticOperations.includes(value.operation) || !diagnosticPhases.includes(value.phase) || !diagnosticReasons.includes(value['sanitized-reason'])) return false;
  if (value.method !== undefined && (typeof value.method !== 'string' || !['GET', 'POST', 'PATCH'].includes(value.method))) return false;
  if (value['sanitized-endpoint'] !== undefined && (typeof value['sanitized-endpoint'] !== 'string' || value['sanitized-endpoint'] !== diagnosticEndpoint(value['sanitized-endpoint']))) return false;
  if (value['request-id'] !== undefined && (typeof value['request-id'] !== 'string' || !/^(?:unavailable|[A-Za-z0-9:-]{1,100})$/.test(value['request-id']))) return false;
  if (value['http-status'] !== undefined && value['http-status'] !== 'unavailable' && (typeof value['http-status'] !== 'number' || !Number.isInteger(value['http-status']) || value['http-status'] < 100 || value['http-status'] > 599)) return false;
  if (value['exit-status'] !== undefined && value['exit-status'] !== 'unavailable' && (typeof value['exit-status'] !== 'number' || !Number.isInteger(value['exit-status']) || value['exit-status'] < 0 || value['exit-status'] > 2147483647)) return false;
  return value.signal === undefined || (typeof value.signal === 'string' && ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGSEGV', 'unavailable'].includes(value.signal));
};
export const diagnosticEndpoint = (endpoint: string): string => {
  const pathname = endpoint.split('?')[0];
  return /^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/(?:releases(?:\/(?:[1-9][0-9]*|assets)(?:\/assets|\/[1-9][0-9]*)?)?|git\/(?:ref\/tags\/v[0-9.]+|tags\/[a-f0-9]{40})|actions\/runs\/[1-9][0-9]*|contents\/[A-Za-z0-9_.\/-]+))?$/.test(pathname) ? pathname : 'unavailable';
};
export const diagnosticFailure = (code: 'remote-state-unknown' | 'standard-installer-failed' | 'owner-adapter-failed', diagnostic: DiagnosticType, cause?: unknown): never => {
  if (!safeDiagnostic(diagnostic)) return fail(code);
  throw new DiagnosticError(`${code}:${JSON.stringify(diagnostic)}`, { cause, diagnostics: diagnostic });
};
export const releaseErrorMessage = (error: unknown): string => {
  let message = '';
  try { if (error instanceof Error && typeof error.message === 'string') message = error.message; } catch { return 'release-validation-failed'; }
  // Unexpected platform/network errors must not disclose tokens, paths or signed redirects.
  const structured = /^(remote-state-unknown|standard-installer-failed|owner-adapter-failed):(.+)$/.exec(message);
  if (structured) {
    try { const value: unknown = JSON.parse(structured[2]); if (safeDiagnostic(value)) return `${structured[1]}:${JSON.stringify(value)}`; } catch { /* Invalid diagnostics are never echoed. */ }
    return structured[1];
  }
  return error instanceof DiagnosticError && /^[a-z][a-z0-9-]+(?::[A-Za-z0-9_.\[\]-]+)?$/.test(message) ? message : 'release-validation-failed';
};
export const readRecord = (filename: string): Record<string, unknown> => {
  const value = readJson(filename);
  if (!record(value)) fail('json-object-invalid');
  return value;
};
export const writeNewJson = (filename: string, value: unknown): void => fs.writeFileSync(filename, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
