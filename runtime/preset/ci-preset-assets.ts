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

export type ValueMap = Record<string, unknown>;
export type Finding = { path: string; message: string; settingLocation?: string };
export type ResourceSource = string | { skill?: string; path: string };
export type WorkflowAsset = { id: string; source: ResourceSource; destination: string };
export type OptionalWorkflowAsset = WorkflowAsset & { companionPaths?: string[] };
export type ConditionalExtension = {
  id: string;
  workflowAsset: string;
  selectorPath: string;
};
export type Preset = {
  id: string;
  workflowAssets: WorkflowAsset[];
  optionalWorkflowAssets?: OptionalWorkflowAsset[];
  assets?: {
    copyable?: string[];
    requiredExtensions?: string[];
    conditionalExtensions?: ConditionalExtension[];
  };
  qualityAdapter?: { source?: string; selection?: string };
  standardImplementation?: {
    selectionEnv?: string;
    requiredBindings?: string[];
  };
};
export type ProviderAsset = {
  id: string;
  entrypoints?: string[];
  source?: ResourceSource;
  copyable?: boolean;
};
export type StandardImplementation = {
  id: string;
  languageProfiles: string[];
  fulfillsExtensions: Record<string, string>;
  projectSettingsEnv: string[];
  dependencies: Array<{ kind: string; id: string }>;
};
export type AdapterBundleAsset = { id: string; destination: string };
export type AdapterBundle = {
  id: string;
  languageProfiles: string[];
  source: ResourceSource;
  targetDescriptor: string;
  delivery?: string;
};
export type AssetLockContract = { path: string; schemaVersion: string; kind: string };
export type ManagedAsset = {
  path: string;
  sourcePath: string;
  exactCopy: boolean;
};
export type TriggerExtensionRule = 'empty-map' | 'cron-list';
export type ActionTarget = {
  id: string;
  status: 'available' | 'pending-release';
  actionPath: string;
  workflows: string[];
  privilegedJobs: string[];
};
export type RegistryData = {
  skillCollectionRoot?: string;
  presets: Preset[];
  providerId: string;
  actionRepository: string;
  actionReleaseTag: string;
  actionExactRef: string;
  pendingActionRef?: string;
  actionTargets: ActionTarget[];
  retiredProjectEntrypoints?: Record<string, string[]>;
  registeredAssets: ProviderAsset[];
  copyableAssets: ProviderAsset[];
  standardImplementations: StandardImplementation[];
  adapterBundles: AdapterBundle[];
  assetLock: AssetLockContract;
  platformManifestPath: string;
  qualityPlatformSelectionPath: string;
  providerStaticValidationConfigPaths: string[];
  approvedProviderActionPins: Map<string, string>;
  approvedProviderActionEntries: Map<string, Record<string, string>>;
  providerActionPinCompanionPath: string;
  providerActionPinCompanionComparison: string;
  providerActionPinFields: string[];
  emptyAllowedPlaceholders: Set<string>;
  qualityTriggerExtensions: Record<string, TriggerExtensionRule>;
  qualityReusableWorkflow?: { source: string; status: 'available' | 'pending-release'; referencePlaceholder: string; exactRef?: string };
};

// Minimal diagnostic surface required by registry interpretation. The validator
// report is structurally compatible and remains the owner of the full report.
export type DiagnosticReport = {
  missingSettings: Finding[];
  mismatches: Finding[];
};

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

export const isMap = (value: unknown): value is ValueMap =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
export const map = (value: unknown): ValueMap => isMap(value) ? value : {};
export const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
export const add = (findings: Finding[], finding: Finding): void => {
  if (!findings.some((item) => item.path === finding.path && item.message === finding.message)) {
    findings.push(finding);
  }
};
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

// Provider static-validation settings are project-owned content. The validator
// only recognizes declared paths so that a project-owned tool config is not
// reported as an unclassified CI asset; it never reads or validates the content.
export const isSafeProviderConfigPath = (value: string): boolean => {
  if (!/^\.(?:github|ci)\//.test(value) || value.includes('\\')) return false;
  const parts = value.split('/');
  return parts.length >= 2
    && parts.every((part) => part.length > 0 && part !== '.' && part !== '..'
      && [...part].every((char) => {
        const code = char.charCodeAt(0);
        return code > 31 && code !== 127;
      }));
};

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

export const adapterBundleAssets = (
  bundle: AdapterBundle,
  skillCollectionRoot?: string,
  report?: DiagnosticReport,
): AdapterBundleAsset[] => {
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

const presetWorkflow = (root: string, preset: Preset): ValueMap => {
  const asset = preset.workflowAssets.find((candidate) => candidate.id === preset.id)
    ?? preset.workflowAssets[0];
  if (!asset) return {};
  const absolute = path.join(root, asset.destination);
  return fs.existsSync(absolute)
    ? map(parseYaml(fs.readFileSync(absolute, 'utf8'), asset.destination))
    : {};
};

const selectedStandardImplementation = (
  root: string,
  registry: RegistryData,
  preset: Preset,
): StandardImplementation | undefined => {
  const selectionEnv = preset.standardImplementation?.selectionEnv;
  if (!selectionEnv) return undefined;
  const selectedId = map(presetWorkflow(root, preset).env)[selectionEnv];
  return typeof selectedId === 'string'
    ? registry.standardImplementations.find((candidate) => candidate.id === selectedId)
    : undefined;
};

export const valueAtPath = (value: unknown, selectorPath: string): unknown =>
  selectorPath.split('.').reduce<unknown>((current, segment) =>
    isMap(current) ? current[segment] : undefined, value);

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
    if (valueAtPath(workflow, extension.selectorPath) !== false) continue;
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

export const standardQualityBundles = (
  registry: RegistryData,
  profile: unknown,
): AdapterBundle[] => typeof profile === 'string'
  ? registry.adapterBundles.filter((bundle) => bundle.languageProfiles.includes(profile))
  : [];

export const normalizeAsset = (value: string): string | undefined => {
  const normalized = path.posix.normalize(value.replace(/^\.ci-base\//, ''));
  return normalized.startsWith('.ci/') && !normalized.includes('/node_modules/') ? normalized : undefined;
};

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
  && typeof value.targetDescriptor === 'string';

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
  const reusable = map(registry.qualityReusableWorkflow);
  if (typeof reusable.source !== 'string' || !/^\.github\/workflows\/[a-z0-9-]+\.ya?ml$/.test(reusable.source)
    || !['available', 'pending-release'].includes(String(reusable.status))
    || typeof reusable.referencePlaceholder !== 'string'
    || reusable.status === 'available' && !FULL_SHA.test(String(reusable.exactRef ?? ''))) add(report.mismatches, {
    path: 'qualityReusableWorkflow', message: 'quality reusable workflow declaration is invalid',
  });
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
          targetDescriptor: String(map(value).targetDescriptor),
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
    qualityReusableWorkflow: typeof reusable.source === 'string' ? {
      source: reusable.source, status: reusable.status as 'available' | 'pending-release',
      referencePlaceholder: String(reusable.referencePlaceholder ?? ''),
      exactRef: typeof reusable.exactRef === 'string' ? reusable.exactRef : undefined,
    } : undefined,
  };
};

export const resolveQualityWorkflow = (
  workflow: ValueMap, registry: RegistryData, report: DiagnosticReport = { missingSettings: [], mismatches: [] },
): ValueMap => {
  const binding = registry.qualityReusableWorkflow;
  const call = map(map(workflow.jobs).quality);
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
        const workflowEnv = map(resolveQualityWorkflow(installed.workflow, registry).env);
        if (typeof workflowEnv.CI_STANDARD_BUNDLE_ID === 'string' && workflowEnv.CI_STANDARD_BUNDLE_ID !== '') continue;
        const descriptor = workflowEnv.CI_ADAPTER_DESCRIPTOR;
        const profile = workflowEnv.CI_LANGUAGE_PROFILE;
        if (typeof descriptor !== 'string' || typeof profile !== 'string') continue;
        const normalized = normalizeAsset(descriptor);
        if (!normalized) continue;
        const bundle = standardQualityBundles(registry, profile)
          .find((candidate) => candidate.targetDescriptor === normalized);
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
        if (map(presetWorkflow(root, preset).env).CI_STANDARD_BUNDLE_ID === bundle.id) continue;
        registerAdapterBundle(bundle);
      }
    }
  }
  return [...result.values()].sort((left, right) => left.path.localeCompare(right.path));
};
