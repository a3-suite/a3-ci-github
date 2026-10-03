import path from 'node:path';

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
  qualityPlatformsReusableWorkflow?: RegistryData['qualityReusableWorkflow'];
  packagePreparationReusableWorkflow?: RegistryData['qualityReusableWorkflow'];
  releasePublicationReusableWorkflow?: RegistryData['qualityReusableWorkflow'];
  packagePublicationReusableWorkflow?: RegistryData['qualityReusableWorkflow'];
};

// Minimal diagnostic surface required by registry interpretation. The validator
// report is structurally compatible and remains the owner of the full report.
export type DiagnosticReport = {
  missingSettings: Finding[];
  mismatches: Finding[];
};

export const isMap = (value: unknown): value is ValueMap =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
export const map = (value: unknown): ValueMap => isMap(value) ? value : {};
export const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

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

export const valueAtPath = (value: unknown, selectorPath: string): unknown =>
  selectorPath.split('.').reduce<unknown>((current, segment) =>
    isMap(current) ? current[segment] : undefined, value);

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

export const publicationBinding = (workflowId: string, registry: RegistryData): RegistryData['qualityReusableWorkflow'] =>
  workflowId === 'release-publication-caller' ? registry.releasePublicationReusableWorkflow
    : workflowId === 'package-publication-caller' ? registry.packagePublicationReusableWorkflow : undefined;

