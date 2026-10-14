import { DiagnosticError } from '../diagnostics/failure.mjs';
import { createHash } from 'node:crypto';
import { STANDARD_QUALITY_BUNDLES } from './standard-quality-bundles.generated.js';

export type StandardQualityBundle = {
  id: string; owner: string;
  sourcePath: string; sha256: string; descriptor: string;
};

export const verifyStandardQualityBundle = (entry: StandardQualityBundle): StandardQualityBundle => {
  if (!/^[0-9a-f]{64}$/.test(entry.sha256) || entry.owner !== 'ci-github'
    || !/^runtime\/adapter\/bundles\/[a-z0-9][a-z0-9-]*\.yml$/.test(entry.sourcePath)
    || createHash('sha256').update(entry.descriptor).digest('hex') !== entry.sha256) {
    throw new DiagnosticError(`quality-adapter-standard-bundle-integrity:${entry.id}`);
  }
  return entry;
};

export const isStandardQualityBundle = (id: unknown): boolean =>
  STANDARD_QUALITY_BUNDLES.some((entry) => entry.id === id);

export const standardQualityBundle = (id: string): StandardQualityBundle => {
  const entry = STANDARD_QUALITY_BUNDLES.find((candidate) => candidate.id === id);
  if (!entry) throw new DiagnosticError(`quality-adapter-standard-bundle-unknown:${id}`);
  return verifyStandardQualityBundle(entry);
};

export const standardSharedQualityCommandIds = (id: string): readonly string[] => {
  if (id !== 'rust-cargo-quality') throw new DiagnosticError('quality-adapter-native-scope-unsupported');
  return ['format', 'security'];
};
