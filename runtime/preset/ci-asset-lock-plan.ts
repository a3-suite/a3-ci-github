import path from 'node:path';
import { writeAssetLock, type AssetLock } from './ci-asset-lock.ts';
import { loadRegistry, managedAssets, selectPresets } from './ci-preset-assets.ts';
import type { Report } from './validation-report.ts';
import { createReport } from './validation-report.ts';
import { inside, sha256 } from './workflow-assets.ts';
import { validateCiPresetInternal } from './validate-ci-preset-core.ts';

const writeCiAssetLock = (options: {
  repoRoot: string;
  skillCollectionRoot?: string;
  sourceRevision: string;
  generatedAt?: string | Date;
}): AssetLock => {
  const root = path.resolve(options.repoRoot);
  return writeAssetLock({
    sourceRevision: options.sourceRevision,
    generatedAt: options.generatedAt,
    validate: () => validateCiPresetInternal({
      repoRoot: options.repoRoot,
      skillCollectionRoot: options.skillCollectionRoot,
    }, false),
    resolvePlan: () => {
      const registryReport: Report = createReport();
      const registry = loadRegistry(registryReport);
      registry.skillCollectionRoot = options.skillCollectionRoot === undefined
        ? undefined
        : path.resolve(options.skillCollectionRoot);
      const selected = selectPresets(root, registry.presets, [], registryReport);
      return {
        schemaVersion: registry.assetLock.schemaVersion,
        kind: registry.assetLock.kind,
        outputRelativePath: registry.assetLock.path,
        assets: managedAssets(root, registry, selected),
      };
    },
    resolveWithinRoot: (relativePath) => inside(root, relativePath),
    sha256,
  });
};

export { writeCiAssetLock };
