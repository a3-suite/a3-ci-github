import { DiagnosticError } from '../../../runtime/diagnostics/failure.mjs';
import { parse } from 'yaml';
import {
  PlatformManifestSemanticError,
  validatePlatformManifestValue,
} from '../../../runtime/platform/platform-manifest-core.mjs';
import type { Platform } from '../../../runtime/platform/platform-manifest-core.mjs';
import { PlatformSelectionError, resolveQualityPlatforms } from '../../../runtime/platform/platform-selection-core.js';

export type { Platform };
export type PlatformMatrix = { include: Platform[] };

export const MAX_MANIFEST_BYTES = 64 * 1024;

const parsePlatformYaml = (text: string, maxAliasCount: number): unknown => {
  try { return parse(text, { maxAliasCount, uniqueKeys: true }); }
  catch (error) {
    const observed = error instanceof Error && error.message.startsWith('Excessive alias count') ? 'Excessive alias count' : 'invalid-yaml';
    throw new DiagnosticError('platform-yaml-invalid', { diagnostics: { field: 'platform-yaml', expected: 'unique-keys-within-alias-limit', observed, maxAliasCount } });
  }
};

const actionError = (error: unknown, manifest: unknown): Error => {
  if (!(error instanceof PlatformManifestSemanticError)) return error as Error;
  const suffix = error.index === undefined ? '' : `-${error.index}`;
  const code = {
    'root-invalid': 'platform-matrix-root-invalid',
    'platforms-empty': 'platform-matrix-platforms-empty',
    'platform-shape-invalid': `platform-matrix-platform${suffix}-shape-invalid`,
    'platform-id-invalid': `platform-matrix-platform${suffix}-id-invalid`,
    'platform-runner-invalid': `platform-matrix-platform${suffix}-runner-invalid`,
    'platform-target-invalid': `platform-matrix-platform${suffix}-target-invalid`,
  }[error.code];
  const field = error.code === 'platform-id-invalid' ? 'id' : error.code === 'platform-target-invalid' ? 'target' : error.code === 'platform-runner-invalid' ? 'runner' : 'platforms';
  const platforms = manifest && typeof manifest === 'object' && 'platforms' in manifest && Array.isArray(manifest.platforms) ? manifest.platforms : [];
  const entry = error.index === undefined ? undefined : platforms[error.index];
  const actual = entry && typeof entry === 'object' ? entry[field] : undefined;
  const safeActual = typeof actual === 'string' && /^[A-Za-z0-9_.+-]{1,200}$/.test(actual) ? actual : 'invalid-or-protected';
  return new DiagnosticError(code ?? 'platform-matrix-invalid', { diagnostics: { stage: 'manifest-identity-validation', field: error.index === undefined ? field : `platforms[${error.index}].${field}`, index: error.index ?? 'unavailable', expected: field === 'runner' ? 'supported-runner' : 'unique-valid-platform-identity', observed: safeActual, duplicate: error.index !== undefined && platforms.slice(0, error.index).some(item => item && typeof item === 'object' && item[field] === actual) } });
};

export const resolvePlatformMatrix = (manifestText: string): PlatformMatrix => {
  if (Buffer.byteLength(manifestText, 'utf8') > MAX_MANIFEST_BYTES) {
    throw new DiagnosticError('platform-matrix-manifest-too-large');
  }

  const manifest = parsePlatformYaml(manifestText, 20);
  try {
    return { include: validatePlatformManifestValue(manifest) };
  } catch (error) {
    throw actionError(error, manifest);
  }
};

export const resolveQualityMatrix = (matrix: PlatformMatrix, selectionText: string) => {
  const selection = parsePlatformYaml(selectionText, 100);
  let include;
  try { include = resolveQualityPlatforms(matrix.include, selection); }
  catch (error) {
    if (!(error instanceof PlatformSelectionError)) throw error;
    throw new DiagnosticError('platform-selection-invalid', { diagnostics: { field: error.field ?? 'platforms', index: error.index ?? 'unavailable', expected: 'unique-declared-platform-id', observed: error.message } });
  }
  return { matrix: { include }, expectedPlatforms: include.map((entry) => entry.platform_id).join(',') };
};
