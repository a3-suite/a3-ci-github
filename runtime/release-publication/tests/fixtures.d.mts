import type { TestContext } from 'vitest';
import type { AssemblyType, ReleaseIdentityType } from '../schema';
import type { ReadOnlyClientType } from '../observation';
import type { Platform } from '../../platform/platform-manifest-core.mjs';
export function standardPublicationTokenEnvironment(repository: string, token: string): Record<string, string>;
export function fixture(t: TestContext, platform?: Platform): {
  root: string;
  identity: ReleaseIdentityType;
  options: Record<string, string> & { repository: string; authorityPath: string; snapshotPath: string; platformManifestPath: string; platformMatrix: string; buildRoot: string; outputRoot: string };
  put(relative: string, value: unknown): string;
  assemble(): AssemblyType;
};
export function remoteClient(f: ReturnType<typeof fixture>, assembly: AssemblyType, changes?: Record<string, unknown>): { client: ReadOnlyClientType; calls: unknown[] };

export function releaseSkillsFixture(t: TestContext): ReturnType<typeof fixture>;
export function selectedReleaseSkillsFixture(t: TestContext): ReturnType<typeof fixture>;
