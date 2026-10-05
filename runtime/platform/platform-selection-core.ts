import type { Platform } from './platform-manifest-core.mjs';

export type QualityPlatform = { platform_id: string; runner: string };

export class PlatformSelectionError extends Error {
  constructor(message: string, readonly index?: number, readonly field?: string) {
    super(message);
    this.name = 'PlatformSelectionError';
  }
}

export const resolveQualityPlatforms = (platforms: Platform[], selection: unknown): QualityPlatform[] => {
  if (typeof selection !== 'object' || selection === null || Array.isArray(selection)
    || Object.keys(selection).join(',') !== 'platforms'
    || !('platforms' in selection) || !Array.isArray(selection.platforms)
    || selection.platforms.length === 0) {
    throw new PlatformSelectionError('quality platform selection must contain only a non-empty platforms list');
  }
  const byId = new Map(platforms.map((platform) => [platform.id, platform]));
  const seen = new Set<string>();
  return selection.platforms.map((entry: unknown, index: number) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)
      || Object.keys(entry).join(',') !== 'id' || !('id' in entry) || typeof entry.id !== 'string') {
      throw new PlatformSelectionError('platform selection entry must contain only an id', index);
    }
    if (seen.has(entry.id)) {
      throw new PlatformSelectionError('platform selection id is duplicated', index, 'id');
    }
    const platform = byId.get(entry.id);
    if (!platform) {
      throw new PlatformSelectionError('platform selection id is not declared in the platform manifest', index, 'id');
    }
    seen.add(entry.id);
    return { platform_id: platform.id, runner: platform.runner };
  });
};
