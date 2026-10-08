import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const runtimeRoot = process.env.CI_GITHUB_PREFLIGHT_RUNTIME_ROOT;
const yamlModule = runtimeRoot
  ? path.join(path.resolve(runtimeRoot), 'node_modules', 'yaml')
  : 'yaml';
const yaml = require(yamlModule) as {
  parseDocument(text: string, options?: object): { errors: Array<{ message: string }>; toJS(): unknown };
};

import { isMap, map, strings, isSafeProviderConfigPath } from './preset-model.ts';
import type { ValueMap, ResourceSource, WorkflowAsset, OptionalWorkflowAsset, Preset, ProviderAsset, StandardImplementation, AdapterBundle, ActionTarget, RegistryData, DiagnosticReport, TriggerExtensionRule } from './preset-model.ts';
import { add } from './validation-report.ts';

export const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REGISTRY_PATH = path.resolve(
  SOURCE_ROOT,
  'skills/ci-github/references/ci-github-preset-assets.reference.yml',
);
export const SKILL_ROOT = SOURCE_ROOT;
const CI_ASSET_REGISTRY_PATH = path.resolve(
  SOURCE_ROOT,
  'skills/ci-github/references/ci-script-assets.reference.yml',
);
const SELF_SKILL = path.basename(SKILL_ROOT);
const FULL_SHA = /^[0-9a-f]{40}$/;

export const parseYaml = (text: string, displayPath: string, report?: DiagnosticReport): unknown => {
  const document = yaml.parseDocument(text, { prettyErrors: false });
  if (document.errors.length > 0) {
    if (report) add(report.mismatches, {
      path: displayPath,
      message: `invalid YAML: ${document.errors[0].message}`,
    });
    return {};
  }
  return document.toJS();
};

const toResourceSource = (value: unknown, defaultSkill: string): ResourceSource => {
  if (typeof value === 'string') return { skill: defaultSkill, path: value };
  if (isMap(value) && typeof value.path === 'string') {
    return typeof value.skill === 'string'
      ? { skill: value.skill, path: value.path }
      : { skill: defaultSkill, path: value.path };
  }
  return '';
};

const normalizeProviderAsset = (
  value: unknown,
  defaultSkill: string,
): ProviderAsset | undefined => {
  if (!isMap(value) || typeof value.id !== 'string') return undefined;
  const asset: ProviderAsset = { id: value.id };
  if (value.source !== undefined) {
    if (!isValidResourceSource(value.source)) return undefined;
    asset.source = toResourceSource(value.source, defaultSkill);
  }
  if (value.entrypoints !== undefined) {
    if (!Array.isArray(value.entrypoints)
      || !value.entrypoints.every((entrypoint) => typeof entrypoint === 'string')) {
      return undefined;
    }
    asset.entrypoints = value.entrypoints;
  }
  if (value.copyable === true) asset.copyable = true;
  return asset;
};

const isValidResourceSource = (value: unknown): boolean =>
  typeof value === 'string'
  || (isMap(value) && typeof value.path === 'string' && value.path.length > 0
    && (value.skill === undefined || typeof value.skill === 'string'));

export const collectProviderStaticValidationConfigPaths = (
  value: unknown,
  report: DiagnosticReport,
): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    add(report.mismatches, {
      path: 'provider.staticValidation',
      message: 'provider static validation must be a list of tool entries',
    });
    return [];
  }
  const paths: string[] = [];
  for (const [index, entry] of value.entries()) {
    const item = map(entry);
    if (typeof item.tool !== 'string' || item.tool.length === 0) add(report.mismatches, {
      path: `provider.staticValidation[${index}].tool`,
      message: 'provider static validation tool must be a non-empty string',
    });
    if (item.ownership !== 'project-content') add(report.mismatches, {
      path: `provider.staticValidation[${index}].ownership`,
      message: 'provider static validation settings must be project-owned content',
    });
    const configPaths = item.configPaths;
    if (!Array.isArray(configPaths) || configPaths.length === 0) {
      add(report.mismatches, {
        path: `provider.staticValidation[${index}].configPaths`,
        message: 'provider static validation config paths must be a non-empty list',
      });
      continue;
    }
    for (const [pathIndex, candidate] of configPaths.entries()) {
      if (typeof candidate !== 'string' || !isSafeProviderConfigPath(candidate)) {
        add(report.mismatches, {
          path: `provider.staticValidation[${index}].configPaths[${pathIndex}]`,
          message: 'provider static validation config path must stay within .github or .ci',
        });
        continue;
      }
      paths.push(candidate);
    }
  }
  return paths;
};

const isValidWorkflowAsset = (value: unknown): value is WorkflowAsset =>
  isMap(value)
  && typeof value.id === 'string'
  && isValidResourceSource(value.source)
  && typeof value.destination === 'string';

const isValidOptionalWorkflowAsset = (value: unknown): value is OptionalWorkflowAsset => {
  if (!isValidWorkflowAsset(value) || !isMap(value)) return false;
  const companionPaths = map(value).companionPaths;
  return companionPaths === undefined
    || (Array.isArray(companionPaths)
      && companionPaths.every((entry) => typeof entry === 'string'));
};

const isValidPreset = (value: unknown): value is Preset =>
  isMap(value)
  && typeof value.id === 'string'
  && Array.isArray(value.workflowAssets)
  && value.workflowAssets.every(isValidWorkflowAsset)
  && (value.optionalWorkflowAssets === undefined
    || (Array.isArray(value.optionalWorkflowAssets)
      && value.optionalWorkflowAssets.every(isValidOptionalWorkflowAsset)));

const isValidActionTarget = (value: unknown): value is ActionTarget =>
  isMap(value)
  && typeof value.id === 'string'
  && (value.status === 'available' || value.status === 'pending-release')
  && typeof value.actionPath === 'string'
  && Array.isArray(value.workflows)
  && Array.isArray(value.privilegedJobs)
  && value.privilegedJobs.every((entry) => typeof entry === 'string');

const isValidStandardImplementation = (value: unknown): value is StandardImplementation =>
  isMap(value)
  && typeof value.id === 'string'
  && Array.isArray(value.languageProfiles)
  && isMap(value.fulfillsExtensions)
  && Array.isArray(value.projectSettingsEnv)
  && Array.isArray(value.dependencies);

const isAdapterBundleShape = (value: unknown): value is ValueMap =>
  isMap(value)
  && typeof value.id === 'string'
  && isValidResourceSource(value.source)
  && (value.delivery === 'action' || value.delivery === undefined && typeof value.targetDescriptor === 'string');

const collectApprovedProviderActionPins = (
  providerActions: ValueMap,
): { pins: Map<string, string>; entries: Map<string, Record<string, string>> } => {
  const pins = new Map<string, string>();
  const entries = new Map<string, Record<string, string>>();
  for (const entry of Array.isArray(providerActions.entries) ? providerActions.entries : []) {
    const candidate = map(entry);
    const action = String(candidate.action ?? '');
    const commitSha = String(candidate.commitSha ?? '');
    if (!action || !FULL_SHA.test(commitSha)) continue;
    pins.set(action, commitSha);
    entries.set(action, Object.fromEntries(
      Object.entries(candidate).map(([key, value]) => [key, String(value ?? '')]),
    ));
  }
  return { pins, entries };
};

const collectQualityTriggerExtensions = (
  conformance: ValueMap,
  report: DiagnosticReport,
): Record<string, TriggerExtensionRule> => {
  const triggerExtensions = map(map(conformance.workflowTriggerExtensions)['quality-gate']);
  const qualityTriggerExtensions: Record<string, TriggerExtensionRule> = {};
  for (const [event, rule] of Object.entries(triggerExtensions)) {
    if (rule === 'empty-map' || rule === 'cron-list') qualityTriggerExtensions[event] = rule;
    else add(report.mismatches, {
      path: `conformance.workflowTriggerExtensions.quality-gate.${event}`,
      message: 'unsupported trigger extension rule',
    });
  }
  return qualityTriggerExtensions;
};

const interpretActionization = (
  actionization: ValueMap,
  report: DiagnosticReport,
): { implementationSource: ValueMap; actionReleaseTag: string; actionExactRef: string } => {
  const implementationSource = map(actionization.implementationSource);
  const actionReleaseTag = String(implementationSource.releaseTag ?? '');
  const actionExactRef = String(implementationSource.exactRef ?? '');
  const availabilityRequirements = strings(map(actionization.availabilityGate).requires);
  for (const target of Array.isArray(actionization.targets) ? actionization.targets : []) {
    if (!isValidActionTarget(target)) add(report.mismatches, {
      path: `actionization.targets.${String(map(target).id ?? 'unknown')}`,
      message: 'Action target declaration or availability status is invalid',
    });
  }
  if (!/^v\d+\.\d+\.\d+$/.test(actionReleaseTag)) add(report.mismatches, {
    path: 'actionization.implementationSource.releaseTag',
    message: 'a3 Action release tag must be an exact vX.Y.Z tag',
  });
  if (!FULL_SHA.test(actionExactRef)) add(report.mismatches, {
    path: 'actionization.implementationSource.exactRef',
    message: 'a3 Action exact ref must be a full lowercase commit SHA',
  });
  for (const requirement of ['exact-release-tag', 'release-tag-mapping', 'exact-ref']) {
    if (!availabilityRequirements.includes(requirement)) add(report.mismatches, {
      path: 'actionization.availabilityGate.requires',
      message: `a3 Action availability gate is missing ${requirement}`,
    });
  }
  return { implementationSource, actionReleaseTag, actionExactRef };
};

export const loadRegistry = (report: DiagnosticReport): RegistryData => {
  const registry = map(parseYaml(fs.readFileSync(REGISTRY_PATH, 'utf8'), REGISTRY_PATH, report));
  const ciAssetRegistry = map(parseYaml(
    fs.readFileSync(CI_ASSET_REGISTRY_PATH, 'utf8'),
    CI_ASSET_REGISTRY_PATH,
    report,
  ));
  const presets = map(registry.registry).presets;
  const providerAssets = registry.providerAssets;
  const commonAssets = ciAssetRegistry.assets;
  const standardImplementations = map(registry.actionization).standardImplementations;
  const adapterBundles = ciAssetRegistry.adapterBundles;
  const integrityLock = map(map(registry.distribution).integrityLock);
  const platformManifest = map(map(registry.provider).platformManifest);
  const qualityPlatformSelection = map(map(registry.provider).qualityPlatformSelection);
  const providerStaticValidationConfigPaths = collectProviderStaticValidationConfigPaths(
    map(registry.provider).staticValidation,
    report,
  );
  const providerActions = map(registry.providerActions);
  const { pins: approvedProviderActionPins, entries: approvedProviderActionEntries } =
    collectApprovedProviderActionPins(providerActions);
  const pinCompanion = map(providerActions.pinCompanion);
  const providerActionPinCompanionPath = String(pinCompanion.path ?? '');
  const providerActionPinCompanionComparison = String(pinCompanion.appliedComparison ?? '');
  const providerActionPinFields = strings(pinCompanion.fields);
  const providerId = String(map(registry.provider).id ?? '');
  const conformance = map(registry.conformance);
  const reusableBindings: Pick<RegistryData, 'qualityReusableWorkflow' | 'qualityPlatformsReusableWorkflow' | 'packagePreparationReusableWorkflow' | 'releasePublicationReusableWorkflow' | 'packagePublicationReusableWorkflow'> = {};
  const manifestPath = path.join(SOURCE_ROOT, 'manifest.json');
  const manifest = fs.existsSync(manifestPath) ? map(JSON.parse(fs.readFileSync(manifestPath, 'utf8'))) : {};
  for (const key of ['qualityReusableWorkflow', 'qualityPlatformsReusableWorkflow', 'packagePreparationReusableWorkflow', 'releasePublicationReusableWorkflow', 'packagePublicationReusableWorkflow'] as const) {
    const reusable = map(registry[key]);
    if (typeof reusable.source !== 'string' || !/^\.github\/workflows\/[a-z0-9-]+\.ya?ml$/.test(reusable.source)
      || typeof reusable.referencePlaceholder !== 'string'
      || Object.keys(reusable).some((field) => !['source', 'referencePlaceholder', 'requiredCallerCheck'].includes(field))) add(report.mismatches, {
      path: key, message: 'reusable workflow declaration is invalid',
    });
    const resolved = map(map(manifest.reusableWorkflows)[String(reusable.source)]);
    const available = FULL_SHA.test(String(manifest.sourceRevision))
      && manifest.kind === 'a3-ci-github-distribution-manifest'
      && manifest.schemaVersion === '2'
      && manifest.repository === 'a3-suite/a3-ci-github'
      && resolved.referencePlaceholder === reusable.referencePlaceholder
      && resolved.sourceRevision === manifest.sourceRevision
      && map(manifest.workflowReferences)[String(reusable.referencePlaceholder).slice(1, -1)] === manifest.sourceRevision;
    if (typeof reusable.source === 'string') reusableBindings[key] = {
      source: reusable.source, status: available ? 'available' : 'pending-release',
      referencePlaceholder: String(reusable.referencePlaceholder ?? ''),
      exactRef: available ? String(manifest.sourceRevision) : undefined,
    };
  }
  const qualityTriggerExtensions = collectQualityTriggerExtensions(conformance, report);
  const actionization = map(registry.actionization);
  const { implementationSource, actionReleaseTag, actionExactRef } =
    interpretActionization(actionization, report);
  const targets = actionization.targets;
  // Omitted `source.skill` identifies a repository-owned asset. Explicit skill
  // identities remain reserved for externally owned language adapter bundles.
  const commonSourceSkill = SELF_SKILL;
  const registeredAssets = [
    ...(Array.isArray(providerAssets) ? providerAssets : [])
      .map((value) => normalizeProviderAsset(value, SELF_SKILL)),
    ...(Array.isArray(commonAssets) ? commonAssets : [])
      .map((value) => normalizeProviderAsset(value, commonSourceSkill)),
  ].filter((value): value is ProviderAsset => value !== undefined);
  return {
    presets: Array.isArray(presets) ? presets.filter(isValidPreset) : [],
    providerId,
    actionRepository: String(implementationSource.repository ?? ''),
    actionReleaseTag,
    actionExactRef,
    pendingActionRef: String(map(actionization.pendingRelease).referencePlaceholder ?? ''),
    actionTargets: Array.isArray(targets) ? targets.filter(isValidActionTarget) : [],
    retiredProjectEntrypoints: Object.fromEntries(Object.entries(map(actionization.retiredProjectEntrypoints)).map(([id, entries]) => [id, strings(entries)])),
    registeredAssets,
    copyableAssets: registeredAssets.filter((value) => value.copyable === true),
    standardImplementations: Array.isArray(standardImplementations)
      ? standardImplementations.filter(isValidStandardImplementation)
      : [],
    adapterBundles: Array.isArray(adapterBundles)
      ? adapterBundles.filter(isAdapterBundleShape)
        .map((value): AdapterBundle => ({
          id: String(value.id),
          languageProfiles: Array.isArray(value.languageProfiles)
            ? value.languageProfiles.filter((item: unknown): item is string => typeof item === 'string')
            : [],
          source: toResourceSource(map(value).source, commonSourceSkill),
          targetDescriptor: value.delivery === 'action' ? undefined : String(value.targetDescriptor),
          delivery: typeof value.delivery === 'string' ? value.delivery : undefined,
        }))
      : [],
    assetLock: {
      path: String(integrityLock.path ?? ''),
      schemaVersion: String(integrityLock.schemaVersion ?? ''),
      kind: String(integrityLock.kind ?? ''),
    },
    platformManifestPath: String(platformManifest.path ?? ''),
    qualityPlatformSelectionPath: String(qualityPlatformSelection.path ?? ''),
    providerStaticValidationConfigPaths,
    approvedProviderActionPins,
    approvedProviderActionEntries,
    providerActionPinCompanionPath,
    providerActionPinCompanionComparison,
    providerActionPinFields,
    emptyAllowedPlaceholders: new Set(strings(conformance.emptyAllowedPlaceholders)),
    qualityTriggerExtensions,
    ...reusableBindings,
  };
};
