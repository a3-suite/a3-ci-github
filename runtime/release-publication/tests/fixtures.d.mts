import type { TestContext } from 'vitest';
import type { AssemblyType, ReleaseIdentityType } from '../schema';
import type { ReadOnlyClientType } from '../observation';
export function fixture(t: TestContext): {
  root: string;
  identity: ReleaseIdentityType;
  options: Record<string, string> & { repository: string; authorityPath: string; snapshotPath: string; platformManifestPath: string; platformMatrix: string; buildRoot: string; outputRoot: string };
  put(relative: string, value: unknown): string;
  assemble(): AssemblyType;
};
export function remoteClient(f: ReturnType<typeof fixture>, assembly: AssemblyType, changes?: Record<string, unknown>): { client: ReadOnlyClientType; calls: unknown[] };
