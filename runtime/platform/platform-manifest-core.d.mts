export type Platform = {
  id: string;
  runner: string;
  target: string;
};

export const PLATFORM_RUNNERS: readonly string[];

export class PlatformManifestSemanticError extends Error {
  readonly code: string;
  readonly index?: number;
  constructor(code: string, message: string, index?: number);
}

export type RunnerPolicy = 'bootstrap' | 'trusted';
export function validatePlatformManifestValue(manifest: unknown, runnerPolicy?: RunnerPolicy): Platform[];
