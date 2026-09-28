import fs from 'node:fs';
import path from 'node:path';

export type AssetLockEntry = {
  path: string;
  canonicalSha256: string;
  appliedSha256: string;
};
export type AssetLock = {
  schemaVersion: string;
  kind: string;
  sourceRevision: string;
  generatedAt: string;
  assets: AssetLockEntry[];
};

// Source view of a managed asset. The validator owns managed-asset resolution
// and passes the resolved assets through `resolvePlan`.
export type AssetLockAsset = {
  path: string;
  sourcePath: string;
};

// Structural view of the pre-write validation result. The writer must not
// depend on the validator report type.
export type AssetLockValidation = {
  status: 'success' | 'failed';
  missingSettings: unknown;
  mismatches: unknown;
};

export type AssetLockPlan = {
  schemaVersion: string;
  kind: string;
  outputRelativePath: string;
  assets: AssetLockAsset[];
};

export type WriteAssetLockOptions = {
  sourceRevision: string;
  generatedAt?: string | Date;
  validate: () => AssetLockValidation;
  resolvePlan: () => AssetLockPlan;
  resolveWithinRoot: (relativePath: string) => string;
  sha256: (absolutePath: string) => string;
};

const FULL_SHA = /^[0-9a-f]{40}$/;

export const minuteTimestamp = (value: string | Date): string => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('generatedAt must be a valid timestamp');
  return `${date.toISOString().slice(0, 16)}Z`;
};

export const writeAssetLock = (options: WriteAssetLockOptions): AssetLock => {
  if (!FULL_SHA.test(options.sourceRevision)) {
    throw new Error('sourceRevision must be a full commit SHA');
  }
  const validation = options.validate();
  if (validation.status !== 'success') {
    throw new Error(`cannot write asset lock for an invalid preset: ${JSON.stringify({
      missingSettings: validation.missingSettings,
      mismatches: validation.mismatches,
    })}`);
  }
  const plan = options.resolvePlan();
  const lock: AssetLock = {
    schemaVersion: plan.schemaVersion,
    kind: plan.kind,
    sourceRevision: options.sourceRevision,
    generatedAt: minuteTimestamp(options.generatedAt ?? new Date()),
    assets: plan.assets.map((asset) => ({
      path: asset.path,
      canonicalSha256: options.sha256(asset.sourcePath),
      appliedSha256: options.sha256(options.resolveWithinRoot(asset.path)),
    })),
  };
  const outputPath = options.resolveWithinRoot(plan.outputRelativePath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(lock, null, 2)}\n`);
  return lock;
};
