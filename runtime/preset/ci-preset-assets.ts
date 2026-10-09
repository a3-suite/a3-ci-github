import fs from 'node:fs';
import path from 'node:path';
import { isMap, map, strings, valueAtPath, conditionalExtensionSelected, normalizeAsset, standardQualityBundles } from './preset-model.ts';
import type { ValueMap, ResourceSource, AdapterBundle, AdapterBundleAsset, Preset, RegistryData, DiagnosticReport, StandardImplementation, ManagedAsset } from './preset-model.ts';
import { SOURCE_ROOT, SKILL_ROOT, parseYaml } from './preset-registry.ts';
import { add } from './validation-report.ts';
import { providerActionPinRepositories } from './provider-action-pins.mjs';

const findSkillRoot = (collectionRoot: string, skill: string): string | undefined => {
  if (!fs.existsSync(collectionRoot)) return undefined;
  const candidates = [path.join(collectionRoot, skill)];
  for (const entry of fs.readdirSync(collectionRoot, { withFileTypes: true })) {
    if (entry.isDirectory()) candidates.push(path.join(collectionRoot, entry.name, skill));
  }
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, 'SKILL.md')));
};

// Unqualified sources are repository-owned. Explicit skill identities are
// resolved only from the caller-provided external skill collection.
export const canonicalSourcePath = (
  source: ResourceSource,
  repositoryRoot = SKILL_ROOT,
  skillCollectionRoot?: string,
): string => {
  const relative = typeof source === 'string' ? source : source.path;
  const self = path.basename(repositoryRoot);
  const skill = typeof source === 'string' ? self : (source.skill ?? self);
  const base = skill === self
    ? repositoryRoot
    : skillCollectionRoot === undefined
      ? undefined
      : findSkillRoot(skillCollectionRoot, skill);
  if (!base || !relative) return '';
  const resolved = path.resolve(base, relative);
  const rel = path.relative(base, resolved);
  return rel.startsWith('..') || path.isAbsolute(rel) ? '' : resolved;
};

export const adapterBundleAssets = (
  bundle: AdapterBundle,
  skillCollectionRoot?: string,
  report?: DiagnosticReport,
): AdapterBundleAsset[] => {
  if (bundle.delivery === 'action') return [];
  const descriptorPath = canonicalSourcePath(bundle.source, SKILL_ROOT, skillCollectionRoot);
  try {
    const descriptor = map(parseYaml(
      fs.readFileSync(descriptorPath, 'utf8'),
      descriptorPath,
      report,
    ));
    return Array.isArray(descriptor.assets)
      ? descriptor.assets.filter((asset): asset is AdapterBundleAsset => isMap(asset)
        && typeof asset.id === 'string'
        && typeof asset.destination === 'string')
      : [];
  } catch {
    if (report) add(report.mismatches, {
      path: String(bundle.source),
      message: 'registered adapter bundle descriptor cannot be loaded',
    });
    return [];
  }
};

const presetWorkflow = (root: string, preset: Preset, registry: RegistryData): ValueMap => {
  const asset = preset.workflowAssets.find((candidate) => candidate.id === preset.id)
    ?? preset.workflowAssets.find((candidate) => candidate.id === `${preset.id}-caller`)
    ?? preset.workflowAssets[0];
  if (!asset) return {};
  const absolute = path.join(root, asset.destination);
  return fs.existsSync(absolute)
    ? resolvePublicationWorkflow(map(parseYaml(fs.readFileSync(absolute, 'utf8'), asset.destination)), registry)
    : {};
};

const selectedStandardImplementation = (
  root: string,
  registry: RegistryData,
  preset: Preset,
): StandardImplementation | undefined => {
  const selectionEnv = preset.standardImplementation?.selectionEnv;
  if (!selectionEnv) return undefined;
  const selectedId = map(presetWorkflow(root, preset, registry).env)[selectionEnv];
  return typeof selectedId === 'string'
    ? registry.standardImplementations.find((candidate) => candidate.id === selectedId)
    : undefined;
};

export const inactiveConditionalEntrypoints = (
  root: string,
  registry: RegistryData,
  preset: Preset,
): Set<string> => {
  const result = new Set<string>();
  for (const extension of preset.assets?.conditionalExtensions ?? []) {
    const workflowAsset = preset.workflowAssets.find((asset) => asset.id === extension.workflowAsset);
    const registered = registry.registeredAssets.find((asset) => asset.id === extension.id);
    if (!workflowAsset || !registered) continue;
    const workflowPath = path.join(root, workflowAsset.destination);
    if (!fs.existsSync(workflowPath)) continue;
    const workflow = parseYaml(fs.readFileSync(workflowPath, 'utf8'), workflowAsset.destination);
    if (conditionalExtensionSelected(workflow, extension) !== false) continue;
    for (const entrypoint of registered.entrypoints ?? []) result.add(entrypoint);
  }
  return result;
};

export const installedPresetWorkflows = (
  root: string,
  preset: Preset,
): Array<{ path: string; workflow: ValueMap }> => {
  const assets = [...preset.workflowAssets, ...(preset.optionalWorkflowAssets ?? [])];
  const result: Array<{ path: string; workflow: ValueMap }> = [];
  for (const asset of assets) {
    const absolute = path.join(root, asset.destination);
    if (!fs.existsSync(absolute)) continue;
    result.push({
      path: asset.destination,
      workflow: map(parseYaml(fs.readFileSync(absolute, 'utf8'), asset.destination)),
    });
  }
  return result;
};

export const resolvePublicationWorkflow = (
  workflow: ValueMap, registry: RegistryData, report: DiagnosticReport = { missingSettings: [], mismatches: [] },
): ValueMap => {
  const call = map(map(workflow.jobs).publish);
  const binding = [registry.releasePublicationReusableWorkflow, registry.packagePublicationReusableWorkflow]
    .find((candidate) => candidate && typeof call.uses === 'string'
      && call.uses.startsWith(`${registry.actionRepository}/${candidate.source}@`));
  if (!binding || typeof call.uses !== 'string'
    || !call.uses.startsWith(`${registry.actionRepository}/${binding.source}@`)) return workflow;
  const source = path.resolve(SOURCE_ROOT, binding.source);
  if (!source.startsWith(`${SOURCE_ROOT}${path.sep}`) || !fs.existsSync(source)
    || !fs.realpathSync(source).startsWith(`${fs.realpathSync(SOURCE_ROOT)}${path.sep}`)) {
    add(report.mismatches, { path: binding.source, message: 'fixed publication reusable workflow source is missing or outside the provider root' });
    return workflow;
  }
  const callee = map(parseYaml(fs.readFileSync(source, 'utf8'), binding.source, report));
  const inputs = map(call.with);
  const definitions = map(map(map(callee.on).workflow_call).inputs);
  const env = Object.fromEntries(Object.entries(map(callee.env)).map(([key, value]) => {
    const match = typeof value === 'string' ? value.match(/^\$\{\{ inputs\.([a-z0-9-]+) \}\}$/) : undefined;
    const input = match?.[1];
    return [key, input ? inputs[input] ?? map(definitions[input]).default : value];
  }));
  return { ...callee, env };
};

export const resolveQualityWorkflow = (
  workflow: ValueMap, registry: RegistryData, report: DiagnosticReport = { missingSettings: [], mismatches: [] },
): ValueMap => {
  const platformCall = map(map(workflow.jobs).platforms);
  const platformBinding = registry.qualityPlatformsReusableWorkflow;
  const isPlatform = platformBinding && typeof platformCall.uses === 'string'
    && platformCall.uses.startsWith(`${registry.actionRepository}/${platformBinding.source}@`);
  const binding = isPlatform ? platformBinding : registry.qualityReusableWorkflow;
  const call = isPlatform ? platformCall : map(map(workflow.jobs).quality);
  if (!binding || typeof call.uses !== 'string'
    || !call.uses.startsWith(`${registry.actionRepository}/${binding.source}@`)) return workflow;
  const source = path.resolve(SOURCE_ROOT, binding.source);
  if (!source.startsWith(`${SOURCE_ROOT}${path.sep}`) || !fs.existsSync(source)) {
    add(report.mismatches, { path: binding.source, message: 'fixed quality reusable workflow source is missing' });
    return workflow;
  }
  const callee = map(parseYaml(fs.readFileSync(source, 'utf8'), binding.source, report));
  const inputs = map(call.with);
  const definitions = map(map(map(callee.on).workflow_call).inputs);
  const env = Object.fromEntries(Object.entries(map(callee.env)).map(([key, value]) => {
    const match = typeof value === 'string' ? value.match(/^\$\{\{ inputs\.([a-z0-9-]+) \}\}$/) : undefined;
    const input = match?.[1];
    return [key, input ? inputs[input] ?? map(definitions[input]).default : value];
  }));
  return { ...callee, env };
};

export const selectPresets = (
  root: string,
  definitions: Preset[],
  requested: string[],
  report: DiagnosticReport,
): Preset[] => {
  const known = new Set(definitions.map((preset) => preset.id));
  for (const id of requested) {
    if (!known.has(id)) add(report.mismatches, { path: id, message: 'unknown preset filter' });
  }
  const selected = definitions.filter((preset) => {
    const existing = preset.workflowAssets.filter((asset) => fs.existsSync(path.join(root, asset.destination)));
    const detected = ['release-request', 'release-publication', 'package-publication'].includes(preset.id)
      ? existing.length > 0
      : existing.length === preset.workflowAssets.length;
    return requested.includes(preset.id) || (requested.length === 0 && detected);
  });
  if (selected.length === 0) add(report.missingSettings, {
    path: '.github/workflows',
    message: 'no installed CI preset workflow was detected',
  });
  return selected;
};

export const managedAssets = (root: string, registry: RegistryData, selected: Preset[]): ManagedAsset[] => {
  const result = new Map<string, ManagedAsset>();
  const registerAdapterBundle = (bundle: AdapterBundle): void => {
    if (bundle.delivery === 'action' || !bundle.targetDescriptor) return;
    result.set(bundle.targetDescriptor, {
      path: bundle.targetDescriptor,
      sourcePath: canonicalSourcePath(bundle.source, SKILL_ROOT, registry.skillCollectionRoot),
      exactCopy: true,
    });
    for (const asset of adapterBundleAssets(bundle, registry.skillCollectionRoot)) {
      const registered = registry.copyableAssets.find((candidate) => candidate.id === asset.id);
      const registeredSource = registered?.source
        ?? (registered?.entrypoints?.length === 1 ? registered.entrypoints[0] : undefined);
      if (!registered || registeredSource === undefined) continue;
      result.set(asset.destination, {
        path: asset.destination,
        sourcePath: canonicalSourcePath(registeredSource, SKILL_ROOT, registry.skillCollectionRoot),
        exactCopy: true,
      });
    }
  };
  for (const preset of selected) {
    for (const asset of preset.workflowAssets) {
      if (!fs.existsSync(path.join(root, asset.destination))) continue;
      result.set(asset.destination, {
        path: asset.destination,
        sourcePath: canonicalSourcePath(asset.source, SKILL_ROOT, registry.skillCollectionRoot),
        exactCopy: false,
      });
    }
    for (const asset of preset.optionalWorkflowAssets ?? []) {
      if (!fs.existsSync(path.join(root, asset.destination))) continue;
      result.set(asset.destination, {
        path: asset.destination,
        sourcePath: canonicalSourcePath(asset.source, SKILL_ROOT, registry.skillCollectionRoot),
        exactCopy: false,
      });
    }
    for (const id of strings(map(preset.assets).copyable)) {
      const providerAsset = registry.copyableAssets.find((candidate) => candidate.id === id);
      if (!providerAsset) continue;
      const copySources = providerAsset.source !== undefined
        ? [providerAsset.source]
        : providerAsset.entrypoints ?? [];
      for (const copySource of copySources) {
        const relative = (typeof copySource === 'string' ? copySource : copySource.path)
          .replace(/^assets\/ci\//, '')
          .replace(/^assets\//, '');
        if (!relative) continue;
        const destination = `.ci/${relative}`;
        result.set(destination, {
          path: destination,
          sourcePath: canonicalSourcePath(copySource, SKILL_ROOT, registry.skillCollectionRoot),
          exactCopy: true,
        });
      }
    }
    if (preset.qualityAdapter) {
      for (const installed of installedPresetWorkflows(root, preset)) {
        const workflowEnv = map(resolvePublicationWorkflow(resolveQualityWorkflow(installed.workflow, registry), registry).env);
        if (typeof workflowEnv.CI_STANDARD_BUNDLE_ID === 'string' && workflowEnv.CI_STANDARD_BUNDLE_ID !== '') continue;
        const descriptor = workflowEnv.CI_ADAPTER_DESCRIPTOR;
        const profile = workflowEnv.CI_LANGUAGE_PROFILE;
        if (typeof descriptor !== 'string' || typeof profile !== 'string') continue;
        const normalized = normalizeAsset(descriptor);
        if (!normalized) continue;
        const bundle = standardQualityBundles(registry, profile)
          .find((candidate) => candidate.delivery !== 'action' && candidate.targetDescriptor === normalized);
        if (!bundle) continue;
        registerAdapterBundle(bundle);
      }
    }
    const implementation = selectedStandardImplementation(root, registry, preset);
    if (implementation) {
      for (const dependency of implementation.dependencies) {
        if (dependency.kind !== 'adapter-bundle') continue;
        const bundle = registry.adapterBundles.find((candidate) => candidate.id === dependency.id);
        if (!bundle) continue;
        if (map(presetWorkflow(root, preset, registry).env).CI_STANDARD_BUNDLE_ID === bundle.id) continue;
        registerAdapterBundle(bundle);
      }
    }
  }
  const requiresPins = selected.some((preset) => installedPresetWorkflows(root, preset).some(({ workflow }) =>
    [...providerActionPinRepositories(workflow)].some((action) => registry.approvedProviderActionPins.has(action))));
  if (requiresPins && registry.providerActionPinCompanionPath) result.set(registry.providerActionPinCompanionPath, {
    path: registry.providerActionPinCompanionPath,
    sourcePath: path.join(SOURCE_ROOT, 'skills/ci-github/references/ci-github-preset-assets.reference.yml'),
    exactCopy: false,
  });
  return [...result.values()].sort((left, right) => left.path.localeCompare(right.path));
};
