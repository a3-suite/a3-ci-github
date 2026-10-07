import { createHash } from 'node:crypto';
import { STANDARD_QUALITY_BUNDLES } from './standard-quality-bundles.generated.js';

export type StandardQualityBundle = {
  id: string; owner: string; sourceRepository: string; sourceRevision: string;
  sourcePath: string; sha256: string; descriptor: string;
};

export const verifyStandardQualityBundle = (entry: StandardQualityBundle): StandardQualityBundle => {
  if (!/^[0-9a-f]{40}$/.test(entry.sourceRevision) || !/^[0-9a-f]{64}$/.test(entry.sha256)
    || entry.sourceRepository !== 'https://github.com/izumilufty/a3-prompts'
    || !entry.sourcePath.startsWith('skills/') || entry.sourcePath.split('/').includes('..')
    || createHash('sha256').update(entry.descriptor).digest('hex') !== entry.sha256) {
    throw new Error(`quality-adapter-standard-bundle-integrity:${entry.id}`);
  }
  return entry;
};

export const isStandardQualityBundle = (id: unknown): boolean =>
  STANDARD_QUALITY_BUNDLES.some((entry) => entry.id === id);

export const standardQualityBundle = (id: string): StandardQualityBundle => {
  const entry = STANDARD_QUALITY_BUNDLES.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`quality-adapter-standard-bundle-unknown:${id}`);
  return verifyStandardQualityBundle(entry);
};
