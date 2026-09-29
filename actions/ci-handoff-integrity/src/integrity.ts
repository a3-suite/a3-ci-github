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
  if (!descriptor || /[\0\n\r]/.test(descriptor)) throw new Error('invalid-handoff-descriptor');
  if (descriptor.includes('\\') || path.isAbsolute(descriptor) || path.posix.isAbsolute(descriptor) || path.win32.isAbsolute(descriptor)) {
    throw new Error('handoff-descriptor-must-be-relative');
  }
  const segments = descriptor.split('/');
  if (segments.some((segment) => segment === '..' || segment === '.' || segment === '')) throw new Error('handoff-descriptor-traversal-rejected');
  const root = fs.realpathSync(handoffRoot);
  if (!fs.statSync(root).isDirectory()) throw new Error('handoff-root-must-be-directory');
  let candidate = root;
  for (const segment of segments) {
    candidate = path.join(candidate, segment);
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) {
      const resolved = fs.realpathSync(candidate);
      if (isOutsideRoot(root, resolved)) throw new Error('handoff-descriptor-symlink-escape');
      throw new Error('handoff-descriptor-symlink-rejected');
    }
  }
  if (isOutsideRoot(root, candidate)) throw new Error('handoff-descriptor-outside-root');
  const stat = fs.lstatSync(candidate);
  if (stat.isSymbolicLink()) throw new Error('handoff-descriptor-symlink-rejected');
  const resolved = fs.realpathSync(candidate);
  if (isOutsideRoot(root, resolved)) throw new Error('handoff-descriptor-symlink-escape');
  if (!fs.statSync(resolved).isFile()) throw new Error('handoff-descriptor-must-be-file');
  return { descriptor: segments.join('/'), absolutePath: resolved };
};

type HandoffDescriptor = { schema: 'ci.handoff.v1'; source_sha: string; version: string; target_identity: string; manifest: string };
type ManifestEntry = { path: string; sha256: string };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const safeText = (value: unknown, error: string): string => {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/.test(value)) throw new Error(error);
  return value;
};

const parseDescriptor = (content: string): HandoffDescriptor => {
  let value: unknown;
  try { value = JSON.parse(content); } catch { throw new Error('handoff-descriptor-json-invalid'); }
  if (!isRecord(value) || value.schema !== 'ci.handoff.v1') throw new Error('handoff-descriptor-schema-invalid');
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
  try { value = JSON.parse(content); } catch { throw new Error('handoff-manifest-json-invalid'); }
  if (!Array.isArray(value) || value.length === 0) throw new Error('handoff-manifest-invalid');
  const paths = new Set<string>();
  return value.map((entry) => {
    if (!isRecord(entry)) throw new Error('handoff-manifest-entry-invalid');
    const entryPath = safeText(entry.path, 'handoff-manifest-path-invalid');
    const digest = safeText(entry.sha256, 'handoff-manifest-digest-invalid');
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('handoff-manifest-digest-invalid');
    if (paths.has(entryPath)) throw new Error('handoff-manifest-duplicate-path');
    paths.add(entryPath);
    return { path: entryPath, sha256: digest };
  });
};

export const validateHandoffIntegrity = (handoffRoot: string, descriptorPath: string, expected: { sourceSha: string; version: string; targetIdentity: string }): HandoffIntegrityResult => {
  const descriptorResult = validateHandoffDescriptor(handoffRoot, descriptorPath);
  const descriptor = parseDescriptor(fs.readFileSync(descriptorResult.absolutePath, 'utf8'));
  if (descriptor.source_sha !== expected.sourceSha) throw new Error('handoff-source-identity-mismatch');
  if (descriptor.version !== expected.version) throw new Error('handoff-version-mismatch');
  if (descriptor.target_identity !== expected.targetIdentity) throw new Error('handoff-target-identity-mismatch');
  const manifestResult = validateHandoffDescriptor(handoffRoot, descriptor.manifest);
  const manifest = parseManifest(fs.readFileSync(manifestResult.absolutePath, 'utf8'));
  for (const entry of manifest) {
    const artifact = validateHandoffDescriptor(handoffRoot, entry.path);
    const digest = crypto.createHash('sha256').update(fs.readFileSync(artifact.absolutePath)).digest('hex');
    if (digest !== entry.sha256) throw new Error('handoff-manifest-checksum-mismatch');
  }
  const manifestDigest = crypto.createHash('sha256').update(fs.readFileSync(manifestResult.absolutePath)).digest('hex');
  return { descriptor: descriptorResult.descriptor, manifest: manifestResult.descriptor, manifestDigest, entries: manifest.length };
};
