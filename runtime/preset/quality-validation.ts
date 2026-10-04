import fs from 'node:fs';
import { PlatformSelectionError, resolveQualityPlatforms } from '../platform/platform-selection-core.ts';
import type { Platform } from '../platform/platform-manifest-core.mjs';
import { validateActionAvailability } from './action-availability.ts';
import path from 'node:path';
import { validatePlatformManifest as validatePlatformManifestContent } from './validate-platform-manifest.ts';
import { adapterBundleAssets, installedPresetWorkflows } from './ci-preset-assets.ts';
import { add } from './validation-report.ts';
import { map, standardQualityBundles, strings, valueAtPath } from './preset-model.ts';
import { parseYaml } from './preset-registry.ts';
import type { Preset, ValueMap, WorkflowAsset } from './preset-model.ts';
import type { InspectionContext } from './validation-report.ts';
import { findWorkflowAssetReferences, inside } from './workflow-assets.ts';
import { descriptorValues, validateDescriptor } from './descriptor-validation.ts';
import { uses } from './workflow-validation.ts';
import { standardQualityBundle } from '../adapter/standard-quality-bundles.ts';
import { resolvePublicationWorkflow, resolveQualityWorkflow } from './ci-preset-assets.ts';

const validateQualityPreset = (
  context: InspectionContext,
  preset: Preset,
): void => {
  const { root, registry } = context;
  if (!preset.qualityAdapter) return;
  const primary = preset.workflowAssets.find((asset) => asset.id === preset.id)
    ?? preset.workflowAssets.find((asset) => asset.id === `${preset.id}-caller`)
    ?? preset.workflowAssets[0];
  for (const installed of installedPresetWorkflows(root, preset)) {
    const workflow = resolvePublicationWorkflow(resolveQualityWorkflow(installed.workflow, registry, context.report), registry, context.report);
    const declared = descriptorValues(workflow).length > 0
      || map(workflow.env).CI_ADAPTER_DESCRIPTOR !== undefined
      || map(workflow.env).CI_STANDARD_BUNDLE_ID !== undefined;
    if (!declared && installed.path !== primary?.destination) continue;
    validateQualityWorkflow(context, installed.path, workflow);
  }
};

const validateQualityWorkflow = (
  context: InspectionContext,
  workflowPath: string,
  workflow: ValueMap,
): void => {
  const { root, registry, report } = context;
  const workflowEnv = map(workflow.env);
  const profile = workflowEnv.CI_LANGUAGE_PROFILE;
  const requiredToolVersion = profile === 'python'
    ? 'CI_UV_VERSION'
    : profile === 'rust' ? 'CI_CARGO_AUDIT_VERSION' : undefined;
  if (requiredToolVersion) {
    const value = workflowEnv[requiredToolVersion];
    if (typeof value !== 'string' || value.trim() === '') add(report.missingSettings, {
      path: `${workflowPath}:env.${requiredToolVersion}`,
      message: `${requiredToolVersion} is required for the selected language profile`,
      settingLocation: workflowPath,
    });
  }
  const values = descriptorValues(workflow);
  const standardId = workflowEnv.CI_STANDARD_BUNDLE_ID;
  if (standardId !== undefined && standardId !== '') {
    if (typeof standardId !== 'string' || values.some((value) => value !== '')) {
      add(report.mismatches, { path: `${workflowPath}:env.CI_STANDARD_BUNDLE_ID`, message: 'select exactly one standard bundle ID or project descriptor', settingLocation: workflowPath });
      return;
    }
    const registered = standardQualityBundles(registry, profile).find((bundle) => bundle.id === standardId && bundle.delivery === 'action');
    if (!registered) {
      add(report.mismatches, { path: `${workflowPath}:env.CI_STANDARD_BUNDLE_ID`, message: 'standard quality bundle is not registered for this language profile', settingLocation: workflowPath });
      return;
    }
    try {
      const standard = standardQualityBundle(standardId);
      if (typeof registered.source === 'string' || registered.source.skill !== standard.owner
        || !standard.sourcePath.endsWith(`/${standard.owner}/${registered.source.path}`)) throw new Error('standard quality bundle source provenance mismatch');
      validateDescriptor(root, `.ci/adapters/${standard.id}.yml`, report, workflowEnv, registry.providerId, standard.descriptor);
    } catch (error) {
      add(report.mismatches, { path: `${workflowPath}:env.CI_STANDARD_BUNDLE_ID`, message: error instanceof Error ? error.message : 'standard bundle integrity failure', settingLocation: workflowPath });
    }
    const jobs = map(workflow.jobs);
    let connected = 0;
    for (const job of Object.values(jobs)) for (const step of Array.isArray(map(job).steps) ? map(job).steps as unknown[] : []) {
      const value = map(step);
      if (typeof value.uses !== 'string' || !value.uses.includes('/actions/ci-quality-adapter@')) continue;
      connected++;
      const inputs = map(value.with);
      const permittedPaths = new Set([
        '${{ env.CI_ADAPTER_DESCRIPTOR }}',
        "${{ env.CI_ADAPTER_DESCRIPTOR && format('{0}/{1}', steps.trusted-assets.outputs.root, env.CI_ADAPTER_DESCRIPTOR) || '' }}",
        "${{ env.CI_ADAPTER_DESCRIPTOR && format('.ci-base/{0}', env.CI_ADAPTER_DESCRIPTOR) || '' }}",
        "${{ env.CI_ADAPTER_DESCRIPTOR && format('{0}/{1}', needs.resolve-platforms.outputs['trusted_root'], env.CI_ADAPTER_DESCRIPTOR) || '' }}",
      ]);
      if (inputs['standard-bundle-id'] !== '${{ env.CI_STANDARD_BUNDLE_ID }}'
        || inputs['bundle-path'] !== undefined && !permittedPaths.has(String(inputs['bundle-path']))) {
        add(report.mismatches, { path: `${workflowPath}:with.standard-bundle-id`, message: 'quality adapter must use the static standard ID without a descriptor path', settingLocation: workflowPath });
      }
    }
    if (connected === 0) add(report.mismatches, { path: workflowPath, message: 'standard quality bundle has no Action binding', settingLocation: workflowPath });
    return;
  }
  const unique = [...new Set(values)];
  if (values.length === 0 || values.every((value) => value === '')) {
    add(report.missingSettings, {
      path: `${workflowPath}:env.CI_ADAPTER_DESCRIPTOR`,
      message: 'quality adapter descriptor is missing',
      settingLocation: workflowPath,
    });
    return;
  }
  if (unique.length !== 1 || values.some((value) => value !== unique[0])) {
    add(report.mismatches, {
      path: `${workflowPath}:env.CI_ADAPTER_DESCRIPTOR`,
      message: 'quality jobs must use one adapter descriptor',
      settingLocation: workflowPath,
    });
    return;
  }
  const standards = standardQualityBundles(registry, profile);
  if (standards.length > 0 && !standards.some((bundle) => bundle.targetDescriptor === unique[0])) {
    add(report.mismatches, {
      path: `${workflowPath}:env.CI_ADAPTER_DESCRIPTOR`,
      message: 'quality adapter descriptor must use the registered standard bundle for the selected language profile',
      settingLocation: workflowPath,
    });
  }
  const destinations = validateDescriptor(
    root,
    unique[0],
    report,
    workflowEnv,
    registry.providerId,
  );
  const references = new Set(findWorkflowAssetReferences(
    root,
    fs.readFileSync(path.join(root, workflowPath), 'utf8'),
  ));
  for (const destination of destinations) {
    if (!references.has(destination)) add(report.mismatches, {
      path: destination,
      message: 'descriptor asset is not invoked by the workflow quality job',
      settingLocation: workflowPath,
    });
  }
};

const validatePlatformManifest = (
  context: InspectionContext,
  preset: Preset,
): void => {
  if (preset.id !== 'release-publication') return;
  const { root, registry, parsed, report } = context;
  const workflowPath = preset.workflowAssets.find((asset) => asset.id === preset.id)?.destination
    ?? (preset.workflowAssets.some((asset) => asset.id === `${preset.id}-caller`) ? `.github/workflows/${preset.id}.yml` : undefined);
  const workflow = workflowPath ? parsed.get(workflowPath) : undefined;
  if (!workflow || !workflowPath) return;
  const configured = map(workflow.env).CI_PLATFORM_MANIFEST;
  if (configured !== registry.platformManifestPath) add(report.mismatches, {
    path: `${workflowPath}:env.CI_PLATFORM_MANIFEST`,
    message: `platform manifest must use ${registry.platformManifestPath}`,
    settingLocation: workflowPath,
  });
  const manifestPath = registry.platformManifestPath;
  if (!manifestPath) return;
  const absolute = inside(root, manifestPath);
  if (!fs.existsSync(absolute)) {
    add(report.missingSettings, {
      path: manifestPath,
      message: 'platform manifest is missing',
      settingLocation: manifestPath,
    });
    return;
  }
  try {
    validatePlatformManifestContent(fs.readFileSync(absolute, 'utf8'));
  } catch (error) {
    add(report.mismatches, {
      path: manifestPath,
      message: error instanceof Error ? error.message : 'platform manifest is invalid',
      settingLocation: manifestPath,
    });
  }
};

const validateQualityPlatformSelection = (
  context: InspectionContext,
  preset: Preset,
): void => {
  const optional = preset.optionalWorkflowAssets ?? [];
  if (optional.length === 0) return;
  const { root, registry, report } = context;
  const selectionPath = registry.qualityPlatformSelectionPath;
  if (!selectionPath) return;
  const selected = optional.filter((asset) =>
    fs.existsSync(path.join(root, asset.destination)));
  if (selected.length === 0) return;
  const manifestPath = registry.platformManifestPath;
  const manifestAbsolute = inside(root, manifestPath);
  if (!fs.existsSync(manifestAbsolute)) {
    add(report.missingSettings, {
      path: manifestPath,
      message: 'platform manifest is required by the quality platform workflow',
      settingLocation: preset.id,
    });
    return;
  }
  const manifestText = fs.readFileSync(manifestAbsolute, 'utf8');
  let platforms: Platform[];
  try {
    platforms = validatePlatformManifestContent(manifestText);
  } catch (error) {
    add(report.mismatches, {
      path: manifestPath,
      message: error instanceof Error ? error.message : 'platform manifest is invalid',
      settingLocation: manifestPath,
    });
    return;
  }
  const selectionAbsolute = inside(root, selectionPath);
  if (!fs.existsSync(selectionAbsolute)) {
    add(report.missingSettings, {
      path: selectionPath,
      message: 'quality platform selection is required by the quality platform workflow',
      settingLocation: selectionPath,
    });
    return;
  }
  try {
    const selection = parseYaml(fs.readFileSync(selectionAbsolute, 'utf8'), selectionPath, report);
    resolveQualityPlatforms(platforms, selection);
  } catch (error) {
    const suffix = error instanceof PlatformSelectionError && error.index !== undefined
      ? `:platforms[${error.index}]${error.field ? `.${error.field}` : ''}` : '';
    add(report.mismatches, {
      path: `${selectionPath}${suffix}`,
      message: error instanceof Error ? error.message : 'quality platform selection is invalid',
      settingLocation: selectionPath,
    });
  }
};

const validateStandardImplementation = (
  context: InspectionContext,
  preset: Preset,
): void => {
  const contract = preset.standardImplementation;
  if (!contract) return;
  const { registry, parsed, report } = context;
  const workflowPath = preset.workflowAssets.find((asset) => asset.id === preset.id)?.destination
    ?? (preset.workflowAssets.some((asset) => asset.id === `${preset.id}-caller`) ? `.github/workflows/${preset.id}.yml` : undefined);
  const workflow = workflowPath ? parsed.get(workflowPath) : undefined;
  if (!workflow || !workflowPath) return;
  const selectionEnv = contract.selectionEnv ?? '';
  const selectedId = map(workflow.env)[selectionEnv];
  if (typeof selectedId !== 'string' || selectedId === '') {
    add(report.missingSettings, {
      path: `${workflowPath}:env.${selectionEnv}`,
      message: 'release implementation selection is missing',
      settingLocation: workflowPath,
    });
    return;
  }
  const implementation = registry.standardImplementations
    .find((candidate) => candidate.id === selectedId);
  if (!implementation) {
    add(report.mismatches, {
      path: `${workflowPath}:env.${selectionEnv}`,
      message: 'release implementation is not registered',
      settingLocation: workflowPath,
    });
    return;
  }
  const languageProfile = map(workflow.env).CI_LANGUAGE_PROFILE;
  if (typeof languageProfile !== 'string'
    || !implementation.languageProfiles.includes(languageProfile)) add(report.mismatches, {
    path: `${workflowPath}:env.CI_LANGUAGE_PROFILE`,
    message: 'release implementation does not support the selected language profile',
    settingLocation: workflowPath,
  });
  for (const setting of implementation.projectSettingsEnv) {
    const value = map(workflow.env)[setting];
    if (typeof value !== 'string' || value.trim() === '') add(report.missingSettings, {
      path: `${workflowPath}:env.${setting}`,
      message: 'selected release implementation setting is missing',
      settingLocation: workflowPath,
    });
  }
  const requiredExtensions = strings(map(preset.assets).requiredExtensions);
  for (const required of strings(contract.requiredBindings)) {
    if (!(required in implementation.fulfillsExtensions)) add(report.mismatches, {
      path: `${selectedId}:fulfillsExtensions.${required}`,
      message: 'standard implementation does not fulfill a required binding',
      settingLocation: workflowPath,
    });
  }
  for (const extension of Object.keys(implementation.fulfillsExtensions)) {
    if (!requiredExtensions.includes(extension)) add(report.mismatches, {
      path: `${selectedId}:fulfillsExtensions.${extension}`,
      message: 'standard implementation fulfills an extension not required by the preset',
      settingLocation: workflowPath,
    });
  }
  const workflowActionUses = new Set(uses(workflow));
  for (const [extension, actionId] of Object.entries(implementation.fulfillsExtensions)) {
    const target = registry.actionTargets.find((candidate) => candidate.id === actionId);
    if (!target) {
      add(report.mismatches, {
        path: `${selectedId}:fulfillsExtensions.${extension}`,
        message: 'standard implementation Action binding is not registered',
        settingLocation: workflowPath,
      });
      continue;
    }
    const ref = target.status === 'pending-release' ? registry.pendingActionRef : registry.actionExactRef;
    const expectedUse = `${registry.actionRepository}/${target.actionPath}@${ref}`;
    if (!workflowActionUses.has(expectedUse)) add(report.mismatches, {
      path: `${selectedId}:fulfillsExtensions.${extension}`,
      message: 'standard implementation Action is not connected to the workflow',
      settingLocation: workflowPath,
    });
  }
  for (const dependency of implementation.dependencies) {
    const bundle = dependency.kind === 'adapter-bundle'
      ? registry.adapterBundles.find((candidate) => candidate.id === dependency.id)
      : undefined;
    if (!bundle) {
      add(report.mismatches, {
      path: `${selectedId}:dependencies.${dependency.id}`,
      message: 'standard implementation dependency is not registered',
      settingLocation: workflowPath,
    });
      continue;
    }
    const selectedDescriptors = [...new Set(descriptorValues(workflow))];
    const standardId = map(workflow.env).CI_STANDARD_BUNDLE_ID;
    const matchesDependency = standardId === bundle.id && bundle.delivery === 'action'
      || (!standardId && selectedDescriptors.length === 1 && selectedDescriptors[0] === bundle.targetDescriptor);
    if (!matchesDependency) add(report.mismatches, {
      path: `${workflowPath}:env.CI_ADAPTER_DESCRIPTOR`,
      message: 'quality adapter descriptor does not match the selected standard implementation dependency',
      settingLocation: workflowPath,
    });
    const dependencyAssets = standardId === bundle.id ? [] : adapterBundleAssets(bundle, registry.skillCollectionRoot, report);
    for (const asset of dependencyAssets) {
      const registered = registry.copyableAssets.find((candidate) => candidate.id === asset.id);
      if (!registered || (registered.entrypoints ?? []).length !== 1) add(report.mismatches, {
        path: `${dependency.id}:assets.${asset.id}`,
        message: 'adapter bundle asset does not resolve to one registered copyable entrypoint',
        settingLocation: bundle.targetDescriptor,
      });
    }
  }
};

const validateConditionalExtensions = (
  context: InspectionContext,
  preset: Preset,
): void => {
  const { root, registry, parsed, report } = context;
  const requiredExtensions = new Set(strings(map(preset.assets).requiredExtensions));
  const copyable = new Set(strings(map(preset.assets).copyable));
  for (const extension of preset.assets?.conditionalExtensions ?? []) {
    const settingPath = `${preset.id}:assets.conditionalExtensions.${extension.id}`;
    if (requiredExtensions.has(extension.id) || copyable.has(extension.id)) add(report.mismatches, {
      path: settingPath,
      message: 'conditional extension must not also be an unconditional preset asset',
    });
    const registered = registry.registeredAssets.find((asset) => asset.id === extension.id);
    if (!registered || registered.copyable === true) {
      add(report.mismatches, {
        path: settingPath,
        message: 'conditional extension must resolve to one project-owned registered asset',
      });
      continue;
    }
    const workflowAsset = preset.workflowAssets.find((asset) => asset.id === extension.workflowAsset);
    const workflow = workflowAsset ? parsed.get(workflowAsset.destination) : undefined;
    if (!workflowAsset || !workflow) {
      add(report.missingSettings, {
        path: settingPath,
        message: 'conditional extension selector workflow is missing',
      });
      continue;
    }
    const selected = valueAtPath(workflow, extension.selectorPath);
    const selectorLocation = `${workflowAsset.destination}:${extension.selectorPath}`;
    if (typeof selected !== 'boolean') {
      add(report.mismatches, {
        path: selectorLocation,
        message: 'conditional extension selector must be a static boolean',
        settingLocation: workflowAsset.destination,
      });
      continue;
    }
    if (!selected) continue;
    const publication = parsed.get(`.github/workflows/${preset.id}.yml`);
    const publicationText = publication ? JSON.stringify(publication) : '';
    const reachable = new Set(findWorkflowAssetReferences(root, publicationText));
    for (const entrypoint of registered.entrypoints ?? []) {
      if (!reachable.has(entrypoint)) add(report.mismatches, {
        path: entrypoint,
        message: 'enabled conditional extension is not reachable from the preset workflow',
        settingLocation: workflowAsset.destination,
      });
      const absolute = inside(root, entrypoint);
      if (!fs.existsSync(absolute)) continue;
      const metadata = fs.lstatSync(absolute);
      if (!metadata.isFile()) add(report.mismatches, {
        path: entrypoint,
        message: 'enabled conditional extension entrypoint must be a regular file',
        settingLocation: entrypoint,
      });
      else if ((metadata.mode & 0o111) === 0) add(report.mismatches, {
        path: entrypoint,
        message: 'enabled conditional extension entrypoint must be executable',
        settingLocation: entrypoint,
      });
    }
  }
};

const validateActionCoverage = (
  context: InspectionContext,
  preset: Preset,
  assets: WorkflowAsset[],
  observedActions: Set<string>,
): void => {
  const { registry, report } = context;
  const installedWorkflowIds = new Set(assets.map((asset) => asset.id));
  if (context.parsed.has(`.github/workflows/${preset.id}.yml`)) installedWorkflowIds.add(preset.id);
  validateActionAvailability(context.root, preset.id, installedWorkflowIds, context.parsed, registry, report);
  const expectedActions = new Set(registry.actionTargets
    .filter((target) => target.workflows.some((workflow) => installedWorkflowIds.has(workflow)))
    .map((target) => target.id));
  for (const action of expectedActions) {
    if (!observedActions.has(action)) add(report.missingSettings, {
      path: `${preset.id}:actions.${action}`,
      message: 'required a3 Action is missing from the installed workflow set',
    });
  }
  for (const action of observedActions) {
    if (!expectedActions.has(action)) add(report.mismatches, {
      path: `${preset.id}:actions.${action}`,
      message: 'installed a3 Action is not mapped by the preset',
    });
  }
};

export { validateQualityPreset, validatePlatformManifest, validateQualityPlatformSelection, validateStandardImplementation, validateConditionalExtensions, validateActionCoverage };
