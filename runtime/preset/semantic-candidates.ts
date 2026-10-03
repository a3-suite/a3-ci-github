import fs from 'node:fs';
import path from 'node:path';
import { inactiveConditionalEntrypoints, managedAssets } from './ci-preset-assets.ts';
import type { Preset, RegistryData, ValueMap } from './preset-model.ts';
import type { Report, SemanticCandidate } from './validation-report.ts';
import { filesUnder, findWorkflowAssetReferences, inventoryUnder } from './workflow-assets.ts';
import { uses } from './workflow-validation.ts';

const addSemanticCandidate = (
  candidates: SemanticCandidate[],
  candidate: SemanticCandidate,
): void => {
  if (!candidates.some((item) => item.kind === candidate.kind
    && item.path === candidate.path
    && item.relatedPaths.join('\n') === candidate.relatedPaths.join('\n'))) {
    candidates.push(candidate);
  }
};

const collectSemanticCandidates = (
  root: string,
  definitions: Preset[],
  selected: Preset[],
  parsed: Map<string, ValueMap>,
  registry: RegistryData,
  report: Report,
): void => {
  const canonicalWorkflows = new Set(definitions.flatMap((preset) =>
    [...preset.workflowAssets, ...(preset.optionalWorkflowAssets ?? [])]
      .map((asset) => asset.destination)));
  const managed = new Set(managedAssets(root, registry, selected).map((asset) => asset.path));
  for (const workflow of filesUnder(root, '.github/workflows', ['.yml', '.yaml'])) {
    if (!canonicalWorkflows.has(workflow)) addSemanticCandidate(report.semanticCandidates, {
      kind: 'unmanaged-workflow',
      path: workflow,
      relatedPaths: [],
      message: 'workflow is outside the preset registry and requires semantic ownership review',
    });
  }

  const reachable = new Set<string>();
  for (const [workflowPath, workflow] of parsed) {
    const preset = selected.find((candidate) =>
      [...candidate.workflowAssets, ...(candidate.optionalWorkflowAssets ?? [])]
        .some((asset) => asset.destination === workflowPath)
      || workflowPath === `.github/workflows/${candidate.id}.yml`);
    const excludedReferences = preset
      ? inactiveConditionalEntrypoints(root, registry, preset)
      : new Set<string>();
    const workflowReachable = new Set(findWorkflowAssetReferences(root, JSON.stringify(workflow), excludedReferences));
    for (const asset of workflowReachable) reachable.add(asset);
    const actionUses = uses(workflow)
      .filter((value) => value.startsWith(`${registry.actionRepository}/`));
    if (actionUses.length === 0) continue;
    const localImplementations = [...workflowReachable]
      .filter((asset) => /\.ci\/(?:scripts|provider|trusted)\//.test(asset)
        && !managed.has(asset));
    for (const local of localImplementations) addSemanticCandidate(report.semanticCandidates, {
      kind: 'action-local-overlap',
      path: local,
      relatedPaths: actionUses.sort(),
      message: 'Action and local implementation coexist; contract meaning and ownership require review',
    });
  }

  const assetFiles = [
    ...filesUnder(root, '.ci/scripts', ['.sh', '.ps1', '.ts', '.js', '.mjs', '.cjs', '.json']),
    ...filesUnder(root, '.ci/provider', ['.sh', '.ps1', '.ts', '.js', '.mjs', '.cjs', '.json']),
    ...filesUnder(root, '.ci/trusted', ['.sh', '.ps1', '.ts', '.js', '.mjs', '.cjs', '.json']),
    ...filesUnder(root, '.ci/runtime', ['.sh', '.ps1', '.ts', '.js', '.mjs', '.cjs', '.json']),
    ...filesUnder(root, '.ci/adapters', ['.yml', '.yaml', '.json']),
  ];
  for (const asset of assetFiles) {
    if (managed.has(asset) || reachable.has(asset)) continue;
    addSemanticCandidate(report.semanticCandidates, {
      kind: 'unreachable-asset',
      path: asset,
      relatedPaths: [],
      message: 'CI asset is not reachable from an installed workflow and requires semantic removal or ownership review',
    });
  }
  const classifiedPaths = new Set(report.semanticCandidates.map((candidate) => candidate.path));
  const skillAdministrativeAssets = new Set([registry.assetLock.path, '.ci/README.md']);
  const providerOwnedConfigPaths = new Set<string>(registry.providerStaticValidationConfigPaths);
  if (selected.some((preset) => preset.id === 'release-publication')) {
    providerOwnedConfigPaths.add(registry.platformManifestPath);
  }
  const optionalCompanions = selected.flatMap((preset) =>
    (preset.optionalWorkflowAssets ?? [])
      .flatMap((asset) => asset.companionPaths ?? []));
  for (const companion of optionalCompanions) providerOwnedConfigPaths.add(companion);
  if (optionalCompanions.length > 0) {
    providerOwnedConfigPaths.add(registry.platformManifestPath);
  }
  if (registry.providerActionPinCompanionPath) {
    providerOwnedConfigPaths.add(registry.providerActionPinCompanionPath);
  }
  for (const asset of [
    ...inventoryUnder(root, '.github'),
    ...inventoryUnder(root, '.ci'),
  ]) {
    if (managed.has(asset) || reachable.has(asset) || skillAdministrativeAssets.has(asset)
      || providerOwnedConfigPaths.has(asset) || classifiedPaths.has(asset)) continue;
    addSemanticCandidate(report.semanticCandidates, {
      kind: 'unclassified-directory-asset',
      path: asset,
      relatedPaths: [],
      message: 'asset is outside the derived CI asset set and requires semantic ownership and necessity review',
    });
  }
  report.semanticCandidates.sort((left, right) =>
    `${left.kind}:${left.path}`.localeCompare(`${right.kind}:${right.path}`));
};

export { collectSemanticCandidates };
