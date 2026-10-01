import type { TestContext } from 'node:test';
export function fixture(t: TestContext): {
  root: string;
  options: Record<string, string> & { repository: string; authorityPath: string; snapshotPath: string; platformManifestPath: string; platformMatrix: string; buildRoot: string; outputRoot: string };
  put(relative: string, value: unknown): string;
  assemble(): unknown;
};
