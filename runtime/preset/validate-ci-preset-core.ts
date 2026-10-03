import fs from 'node:fs';
import path from 'node:path';
import { add } from './validation-report.ts';
import { loadRegistry, parseYaml } from './preset-registry.ts';
import { managedAssets, selectPresets } from './ci-preset-assets.ts';
import { map } from './preset-model.ts';
import type { ValueMap } from './preset-model.ts';
import type { Report } from './validation-report.ts';
import { createReport } from './validation-report.ts';
import { collectSemanticCandidates } from './semantic-candidates.ts';
import { inspectWorkflowAsset, remapPublicationDiagnostics, localWorkflows, validateAssetLock, validateCommon, validateCopiedAssetContent, validateNoProjectRuntime, validateProviderActionPinCompanion } from './workflow-validation.ts';
import { validateCaller, validatePackagePublicationFlow, validatePublicationConcurrency, validatePublicationRequest, validateReleasePublicationFlow } from './publication-validation.ts';
import { validateActionCoverage, validateConditionalExtensions, validatePlatformManifest, validateQualityPlatformSelection, validateQualityPreset, validateStandardImplementation } from './quality-validation.ts';

const validateCiPresetInternal = (options: {
  repoRoot: string;
  skillCollectionRoot?: string;
  presets?: string[];
}, requireAssetLock: boolean): Report => {
  const report: Report = createReport();
  const root = path.resolve(options.repoRoot);
  const registry = loadRegistry(report);
  registry.skillCollectionRoot = options.skillCollectionRoot === undefined
    ? undefined
    : path.resolve(options.skillCollectionRoot);
  const definitions = registry.presets;
  const actionByPath = new Map(registry.actionTargets.map((target) =>
    [`${registry.actionRepository}/${target.actionPath}`, target]));
  const requested = [...new Set(options.presets ?? [])];
  const selected = selectPresets(root, definitions, requested, report);
  report.inspectedPresets = selected.map((preset) => preset.id);
  report.excludedPresets = definitions.map((preset) => preset.id)
    .filter((id) => !report.inspectedPresets.includes(id));

  const allCanonical = definitions.flatMap((preset) =>
    preset.workflowAssets.map((asset) => asset.destination));
  const parsed = new Map<string, ValueMap>();
  const context = { root, registry, actionByPath, parsed, report };
  for (const preset of selected) {
    const observedActions = new Set<string>();
    let assets = preset.workflowAssets;
    if (preset.id === 'release-request') {
      assets = assets.filter((asset) => fs.existsSync(path.join(root, asset.destination)));
    }
    for (const asset of preset.optionalWorkflowAssets ?? []) {
      const companions = asset.companionPaths ?? [];
      const workflowExists = fs.existsSync(path.join(root, asset.destination));
      const allCompanionsExist = companions.length > 0
        && companions.every((companion) => fs.existsSync(path.join(root, companion)));
      if (workflowExists && !allCompanionsExist) add(report.mismatches, {
        path: asset.destination,
        message: 'optional workflow asset requires its companion assets',
        settingLocation: asset.destination,
      });
      if (workflowExists) assets = [...assets, asset];
    }
    if (assets.length === 0) add(report.missingSettings, {
      path: preset.id,
      message: 'selected preset has no installed trigger variant',
    });
    for (const asset of assets) {
      inspectWorkflowAsset(
        context,
        preset,
        asset,
        observedActions,
      );
    }
    validateQualityPreset(context, preset);
    validatePlatformManifest(context, preset);
    validateQualityPlatformSelection(context, preset);
    validateStandardImplementation(context, preset);
    validateConditionalExtensions(context, preset);
    validateActionCoverage(context, preset, assets, observedActions);
  }
  report.inspectedWorkflows = [...new Set(report.inspectedWorkflows)].sort();
  report.excludedWorkflows = allCanonical
    .filter((workflow) => !report.inspectedWorkflows.includes(workflow))
    .sort();

  for (const [displayPath, workflow] of [...parsed]) {
    for (const local of localWorkflows(workflow)) {
      if (parsed.has(local) || !fs.existsSync(path.join(root, local))) continue;
      const text = fs.readFileSync(path.join(root, local), 'utf8');
      const target = map(parseYaml(text, local, report));
      parsed.set(local, target);
      validateCommon(root, local, text, target, report, registry);
    }
    if (displayPath.endsWith('package-publication-request.yml')) {
      validatePublicationRequest(
        displayPath,
        workflow,
        ['source_sha', 'version', 'target_identity', 'language_profile', 'toolchain'],
        report,
      );
    }
    if (displayPath.endsWith('release-publication-request.yml')) {
      validatePublicationRequest(
        displayPath,
        workflow,
        ['request_run_id', 'release_identity', 'release_notes', 'approval_expires_at'],
        report,
      );
    }
  }
  for (const callerPath of [
    '.github/workflows/release-publication-caller.yml',
    '.github/workflows/package-publication-caller.yml',
  ]) {
    const caller = parsed.get(callerPath);
    if (caller) validateCaller(callerPath, caller, parsed, report);
  }
  validateReleasePublicationFlow(parsed, report);
  validatePackagePublicationFlow(parsed, report);
  validatePublicationConcurrency(parsed, report);

  validateNoProjectRuntime(root, report);
  validateProviderActionPinCompanion(root, parsed, registry, report);
  collectSemanticCandidates(root, definitions, selected, parsed, registry, report);
  report.semanticReviewRequired = selected.length > 0;

  const integrityAssets = managedAssets(root, registry, selected);
  validateCopiedAssetContent(root, integrityAssets, report);
  if (requireAssetLock) validateAssetLock(
    root,
    registry,
    integrityAssets,
    report,
    requested.length > 0,
  );

  remapPublicationDiagnostics(parsed, registry, report);
  report.evidence.unshift(...report.inspectedWorkflows.map((workflow) => `${workflow}: inspected`));
  if (report.missingSettings.length > 0 || report.mismatches.length > 0) report.status = 'failed';
  return report;
};

const validateCiPreset = (options: {
  repoRoot: string;
  skillCollectionRoot?: string;
  presets?: string[];
}): Report => validateCiPresetInternal(options, true);

export { validateCiPreset, validateCiPresetInternal };
