import type { Platform } from './platform-manifest-core.mjs';

export type QualityPlatform = { platform_id: string; runner: string; shared_standard_checks?: boolean };

export class PlatformSelectionError extends Error {
  constructor(message: string, readonly index?: number, readonly field?: string) {
    super(message);
    this.name = 'PlatformSelectionError';
  }
}

export const resolveQualityPlatforms = (platforms: Platform[], selection: unknown): QualityPlatform[] => {
  if (typeof selection !== 'object' || selection === null || Array.isArray(selection)
    || Object.keys(selection).some(key => key !== 'platforms' && key !== 'sharedStandardChecks')
    || !('platforms' in selection) || !Array.isArray(selection.platforms)
    || selection.platforms.length === 0) {
    throw new PlatformSelectionError('quality platform selection requires a non-empty platforms list and permits only optional sharedStandardChecks');
  }
  if ('sharedStandardChecks' in selection && typeof selection.sharedStandardChecks !== 'boolean') {
    throw new PlatformSelectionError('sharedStandardChecks must be a boolean', undefined, 'sharedStandardChecks');
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
    return { platform_id: platform.id, runner: platform.runner,
      ...('sharedStandardChecks' in selection ? { shared_standard_checks: selection.sharedStandardChecks as boolean } : {}) };
  });
};
