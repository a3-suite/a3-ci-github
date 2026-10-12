import { DiagnosticError, FailureContext } from '../../../runtime/diagnostics/failure.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type ValidatedHandoffDescriptor = { descriptor: string; absolutePath: string };
export type HandoffIntegrityResult = { descriptor: string; manifest: string; manifestDigest: string; entries: number };

const isOutsideRoot = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
};

export const validateHandoffDescriptor = (handoffRoot: string, descriptor: string): ValidatedHandoffDescriptor => {
  if (!descriptor || /[\0\n\r]/.test(descriptor)) throw new DiagnosticError('invalid-handoff-descriptor');
  if (descriptor.includes('\\') || path.isAbsolute(descriptor) || path.posix.isAbsolute(descriptor) || path.win32.isAbsolute(descriptor)) {
    throw new DiagnosticError('handoff-descriptor-must-be-relative');
  }
  const segments = descriptor.split('/');
  if (segments.some((segment) => segment === '..' || segment === '.' || segment === '')) throw new DiagnosticError('handoff-descriptor-traversal-rejected');
  const root = fs.realpathSync(handoffRoot);
  if (!fs.statSync(root).isDirectory()) throw new DiagnosticError('handoff-root-must-be-directory');
  let candidate = root;
  for (const segment of segments) {
    candidate = path.join(candidate, segment);
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) {
      const resolved = fs.realpathSync(candidate);
      if (isOutsideRoot(root, resolved)) throw new DiagnosticError('handoff-descriptor-symlink-escape');
      throw new DiagnosticError('handoff-descriptor-symlink-rejected');
    }
  }
  if (isOutsideRoot(root, candidate)) throw new DiagnosticError('handoff-descriptor-outside-root');
  const stat = fs.lstatSync(candidate);
  if (stat.isSymbolicLink()) throw new DiagnosticError('handoff-descriptor-symlink-rejected');
  const resolved = fs.realpathSync(candidate);
  if (isOutsideRoot(root, resolved)) throw new DiagnosticError('handoff-descriptor-symlink-escape');
  if (!fs.statSync(resolved).isFile()) throw new DiagnosticError('handoff-descriptor-must-be-file');
  return { descriptor: segments.join('/'), absolutePath: resolved };
};

type HandoffDescriptor = { schema: 'ci.handoff.v1'; source_sha: string; version: string; target_identity: string; manifest: string };
type ManifestEntry = { path: string; sha256: string };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const safeText = (value: unknown, error: string): string => {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/.test(value)) throw new DiagnosticError(error);
  return value;
};

const parseDescriptor = (content: string): HandoffDescriptor => {
  let value: unknown;
  try { value = JSON.parse(content); } catch { throw new DiagnosticError('handoff-descriptor-json-invalid'); }
  if (!isRecord(value) || value.schema !== 'ci.handoff.v1') throw new DiagnosticError('handoff-descriptor-schema-invalid');
  return {
    schema: 'ci.handoff.v1',
    source_sha: safeText(value.source_sha, 'handoff-source-sha-invalid'),
    version: safeText(value.version, 'handoff-version-invalid'),
    target_identity: safeText(value.target_identity, 'handoff-target-identity-invalid'),
    manifest: safeText(value.manifest, 'handoff-manifest-invalid'),
  };
};

const parseManifest = (content: string): ManifestEntry[] => {
  let value: unknown;
  try { value = JSON.parse(content); } catch { throw new DiagnosticError('handoff-manifest-json-invalid'); }
  if (!Array.isArray(value) || value.length === 0) throw new DiagnosticError('handoff-manifest-invalid');
  const paths = new Set<string>();
  return value.map((entry) => {
    if (!isRecord(entry)) throw new DiagnosticError('handoff-manifest-entry-invalid');
    const entryPath = safeText(entry.path, 'handoff-manifest-path-invalid');
    const digest = safeText(entry.sha256, 'handoff-manifest-digest-invalid');
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new DiagnosticError('handoff-manifest-digest-invalid');
    if (paths.has(entryPath)) throw new DiagnosticError('handoff-manifest-duplicate-path');
    paths.add(entryPath);
    return { path: entryPath, sha256: digest };
  });
};

export const validateHandoffIntegrity = (handoffRoot: string, descriptorPath: string, expected: { sourceSha: string; version: string; targetIdentity: string }): HandoffIntegrityResult => {
  const diagnostic = new FailureContext('ci-handoff-integrity', 'handoff-integrity');
  const digestOf = (bytes: Buffer): string => crypto.createHash('sha256').update(bytes).digest('hex');
  const publicIdentity = (value: string): string => /^[A-Za-z0-9_.+-]{1,200}$/.test(value) ? value : 'protected-or-invalid';
  try {
    diagnostic.at('descriptor-path-validation', { input: 'descriptor' });
    const descriptorResult = validateHandoffDescriptor(handoffRoot, descriptorPath);
    diagnostic.confirmed();
    diagnostic.at('descriptor-read', { path: descriptorResult.descriptor });
    const descriptor = parseDescriptor(fs.readFileSync(descriptorResult.absolutePath, 'utf8'));
    diagnostic.confirmed();
    diagnostic.at('handoff-identity-comparison', { path: descriptorResult.descriptor, source: publicIdentity(descriptor.source_sha), version: publicIdentity(descriptor.version), target: publicIdentity(descriptor.target_identity) });
    for (const [field, observed, wanted, reason] of [
      ['source-sha', descriptor.source_sha, expected.sourceSha, 'handoff-source-identity-mismatch'],
      ['version', descriptor.version, expected.version, 'handoff-version-mismatch'],
      ['target-identity', descriptor.target_identity, expected.targetIdentity, 'handoff-target-identity-mismatch'],
    ]) {
      if (observed !== wanted) throw new DiagnosticError(reason, { diagnostics: { field, path: descriptorResult.descriptor, expected: publicIdentity(wanted), observed: publicIdentity(observed) } });
    }
    diagnostic.confirmed();
    diagnostic.at('manifest-path-validation', { input: 'manifest' });
    const manifestResult = validateHandoffDescriptor(handoffRoot, descriptor.manifest);
    diagnostic.confirmed();
    diagnostic.at('manifest-read', { path: manifestResult.descriptor });
    const manifestBytes = fs.readFileSync(manifestResult.absolutePath);
    const manifest = parseManifest(manifestBytes.toString('utf8'));
    diagnostic.confirmed();
    for (const entry of manifest) {
      diagnostic.at('artifact-path-validation', { input: 'manifest-entry' });
      const artifact = validateHandoffDescriptor(handoffRoot, entry.path);
      diagnostic.confirmed();
      diagnostic.at('artifact-digest-comparison', { path: artifact.descriptor });
      const bytes = fs.readFileSync(artifact.absolutePath);
      const digest = digestOf(bytes);
      if (digest !== entry.sha256) throw new DiagnosticError('handoff-manifest-checksum-mismatch', { diagnostics: { field: 'artifact-sha256', path: artifact.descriptor, expected: entry.sha256, observed: digest, observedSize: bytes.length, expectedSize: 'not-declared' } });
      diagnostic.confirmed();
    }
    diagnostic.at('manifest-reread-comparison', { path: manifestResult.descriptor });
    const observedManifest = fs.readFileSync(manifestResult.absolutePath);
    if (!manifestBytes.equals(observedManifest)) throw new DiagnosticError('handoff-manifest-checksum-mismatch', { diagnostics: { field: 'manifest-sha256', path: manifestResult.descriptor, expected: digestOf(manifestBytes), observed: digestOf(observedManifest), expectedSize: manifestBytes.length, observedSize: observedManifest.length } });
    return { descriptor: descriptorResult.descriptor, manifest: manifestResult.descriptor, manifestDigest: digestOf(manifestBytes), entries: manifest.length };
  } catch (error) {
    throw diagnostic.capture(error);
  }
};
