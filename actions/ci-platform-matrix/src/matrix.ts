import { parse } from 'yaml';
import {
  PlatformManifestSemanticError,
  validatePlatformManifestValue,
} from '../../../runtime/platform/platform-manifest-core.mjs';
import type { Platform } from '../../../runtime/platform/platform-manifest-core.mjs';
import { resolveQualityPlatforms } from '../../../runtime/platform/platform-selection-core.js';

export type { Platform };
export type PlatformMatrix = { include: Platform[] };

export const MAX_MANIFEST_BYTES = 64 * 1024;

const actionError = (error: unknown): Error => {
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
  return new Error(code ?? 'platform-matrix-invalid');
};

export const resolvePlatformMatrix = (manifestText: string): PlatformMatrix => {
  if (Buffer.byteLength(manifestText, 'utf8') > MAX_MANIFEST_BYTES) {
    throw new Error('platform-matrix-manifest-too-large');
  }

  const manifest = parse(manifestText, { maxAliasCount: 20, uniqueKeys: true }) as unknown;
  try {
    return { include: validatePlatformManifestValue(manifest) };
  } catch (error) {
    throw actionError(error);
  }
};

export const resolveQualityMatrix = (matrix: PlatformMatrix, selectionText: string) => {
  const selection = parse(selectionText, { maxAliasCount: 100, uniqueKeys: true }) as unknown;
  const include = resolveQualityPlatforms(matrix.include, selection);
  return { matrix: { include }, expectedPlatforms: include.map((entry) => entry.platform_id).join(',') };
};
