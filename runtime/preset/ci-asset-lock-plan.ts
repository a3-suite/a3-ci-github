import fs from 'node:fs';
import path from 'node:path';
import { DiagnosticError } from '../diagnostics/failure.mjs';
import { writeAssetLock, type AssetLock } from './ci-asset-lock.ts';
import { loadRegistry, SOURCE_ROOT } from './preset-registry.ts';
import { managedAssets, selectPresets } from './ci-preset-assets.ts';
import type { Report } from './validation-report.ts';
import { createReport } from './validation-report.ts';
import { inside, sha256 } from './workflow-assets.ts';
import { validateCiPresetInternal } from './validate-ci-preset-core.ts';

const writeCiAssetLock = (options: {
  repoRoot: string;
  skillCollectionRoot?: string;
  sourceRevision: string;
  releaseTag: string;
  generatedAt?: string | Date;
}): AssetLock => {
  const root = path.resolve(options.repoRoot);
  // A fetched distribution keeps its verified Release manifest beside the sources, so the lock must name that Release.
  const manifestPath = path.join(SOURCE_ROOT, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { sourceRevision?: unknown; releaseTag?: unknown };
    if (manifest.sourceRevision !== options.sourceRevision || manifest.releaseTag !== options.releaseTag) {
      throw new DiagnosticError('asset lock source must match the fetched distribution Release', { diagnosticCode: 'asset-lock-release-mismatch',
        diagnostics: { stage: 'release-binding', field: 'release-tag', expected: 'fetched-distribution-release', observed: 'differs' } });
    }
  }
  return writeAssetLock({
    sourceRevision: options.sourceRevision,
    releaseTag: options.releaseTag,
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
      const selected = selectPresets(root, registry.presets, [], registryReport, registry);
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
