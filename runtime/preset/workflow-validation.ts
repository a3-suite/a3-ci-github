import fs from 'node:fs';
import path from 'node:path';
import { FULL_SHA, minuteTimestamp } from './ci-asset-lock.ts';
import { SKILL_ROOT, parseYaml } from './preset-registry.ts';
import { add } from './validation-report.ts';
import { canonicalSourcePath, inactiveConditionalEntrypoints, resolveQualityWorkflow, resolvePublicationWorkflow } from './ci-preset-assets.ts';
import { isMap, map, strings, publicationBinding } from './preset-model.ts';
import type { Finding, ManagedAsset, Preset, RegistryData, TriggerExtensionRule, ValueMap, WorkflowAsset } from './preset-model.ts';
import type { InspectionContext, Report } from './validation-report.ts';
import { findWorkflowAssetReferences, inside, realPathIsInside, sha256 } from './workflow-assets.ts';

const SHA256 = /^[0-9a-f]{64}$/;

const MINUTE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/;

const PLACEHOLDER = /<[A-Za-z][A-Za-z0-9._-]*>/;


const placeholderPattern = (
  value: string,
  emptyAllowedPlaceholders: Set<string>,
): RegExp | undefined => {
  if (!PLACEHOLDER.test(value)) return undefined;
  const escaped = value
    .split(/(<[A-Za-z][A-Za-z0-9._-]*>)/g)
    .map((part) => /^<[A-Za-z][A-Za-z0-9._-]*>$/.test(part)
      ? (emptyAllowedPlaceholders.has(part.slice(1, -1)) ? '.*' : '.+')
      : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('');
  return new RegExp(`^${escaped}$`);
};

const compareCanonicalValue = (
  expected: unknown,
  actual: unknown,
  currentPath: string,
  differences: Finding[],
  emptyAllowedPlaceholders: Set<string>,
): void => {
  if (typeof expected === 'string') {
    const pattern = placeholderPattern(expected, emptyAllowedPlaceholders);
    if (pattern) {
      const configured = isMap(actual) || Array.isArray(actual) ? undefined : String(actual ?? '');
      if (configured === undefined || !pattern.test(configured)) differences.push({
        path: currentPath,
        message: 'configured value does not match the canonical placeholder position',
      });
      return;
    }
    if (expected !== actual) differences.push({
      path: currentPath,
      message: 'value differs from the canonical workflow',
    });
    return;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      differences.push({ path: currentPath, message: 'value type differs from the canonical workflow' });
      return;
    }
    if (expected.length > 0 && expected.every((value) => typeof value === 'string'
      && /^<[A-Za-z][A-Za-z0-9._-]*>$/.test(value))) {
      if (actual.length === 0 || actual.some((value) => typeof value !== 'string' || value === '')) {
        differences.push({
          path: currentPath,
          message: 'configured list must contain one or more non-empty values',
        });
      }
      return;
    }
    if (expected.length !== actual.length) {
      differences.push({ path: currentPath, message: 'list length differs from the canonical workflow' });
      return;
    }
    expected.forEach((value, index) => compareCanonicalValue(
      value,
      actual[index],
      `${currentPath}[${index}]`,
      differences,
      emptyAllowedPlaceholders,
    ));
    return;
  }
  if (isMap(expected)) {
    if (!isMap(actual)) {
      differences.push({ path: currentPath, message: 'value type differs from the canonical workflow' });
      return;
    }
    const expectedKeys = Object.keys(expected).sort();
    const actualKeys = Object.keys(actual).sort();
    for (const key of expectedKeys.filter((value) => !(value in actual))) differences.push({
      path: `${currentPath}.${key}`,
      message: 'canonical workflow field is missing',
    });
    for (const key of actualKeys.filter((value) => !(value in expected))) differences.push({
      path: `${currentPath}.${key}`,
      message: 'field is not declared by the canonical workflow',
    });
    for (const key of expectedKeys.filter((value) => value in actual)) compareCanonicalValue(
      expected[key],
      actual[key],
      `${currentPath}.${key}`,
      differences,
      emptyAllowedPlaceholders,
    );
    return;
  }
  if (expected !== actual) differences.push({
    path: currentPath,
    message: 'value differs from the canonical workflow',
  });
};

const triggerExtensionMatches = (value: unknown, rule: TriggerExtensionRule): boolean => {
  if (rule === 'empty-map') return value === null || (isMap(value) && Object.keys(value).length === 0);
  return Array.isArray(value) && value.length > 0 && value.every((entry) => {
    if (!isMap(entry) || Object.keys(entry).length !== 1) return false;
    return typeof entry.cron === 'string' && entry.cron.trim() !== '' && !/[\r\n]/.test(entry.cron);
  });
};

const normalizeTriggerExtensions = (
  asset: WorkflowAsset,
  canonical: ValueMap,
  workflow: ValueMap,
  extensions: Record<string, TriggerExtensionRule>,
  report: Report,
): ValueMap => {
  if (asset.id !== 'quality-gate' || !isMap(workflow.on)) return workflow;
  const canonicalOn = map(canonical.on);
  const normalizedOn = { ...workflow.on };
  for (const [event, rule] of Object.entries(extensions)) {
    if (!(event in normalizedOn) || event in canonicalOn) continue;
    if (!triggerExtensionMatches(normalizedOn[event], rule)) add(report.mismatches, {
      path: `${asset.destination}:on.${event}`,
      message: `registered trigger extension must match ${rule}`,
      settingLocation: asset.destination,
    });
    delete normalizedOn[event];
  }
  return { ...workflow, on: normalizedOn };
};

const validateCanonicalWorkflow = (
  asset: WorkflowAsset,
  workflow: ValueMap,
  registry: RegistryData,
  report: Report,
): ValueMap | undefined => {
  const sourcePath = canonicalSourcePath(asset.source, SKILL_ROOT, registry.skillCollectionRoot);
  if (!sourcePath || !sourcePath.startsWith(`${SKILL_ROOT}${path.sep}`)) {
    add(report.mismatches, {
      path: String(asset.source),
      message: 'canonical workflow source is outside the a3-ci-github repository',
    });
    return undefined;
  }
  if (!fs.existsSync(sourcePath)) {
    add(report.mismatches, {
      path: String(asset.source),
      message: 'canonical workflow source is missing from the a3-ci-github repository',
    });
    return undefined;
  }
  const canonical = map(parseYaml(fs.readFileSync(sourcePath, 'utf8'), String(asset.source), report));
  const comparedWorkflow = normalizeTriggerExtensions(
    asset,
    canonical,
    workflow,
    registry.qualityTriggerExtensions,
    report,
  );
  const differences: Finding[] = [];
  compareCanonicalValue(
    canonical,
    comparedWorkflow,
    asset.destination,
    differences,
    registry.emptyAllowedPlaceholders,
  );
  for (const difference of differences) add(report.mismatches, {
    ...difference,
    message: `canonical drift: ${difference.message}`,
    settingLocation: asset.destination,
  });
  return canonical;
};

const validatePublicationControl = (
  asset: WorkflowAsset,
  text: string,
  workflow: ValueMap,
  canonical: ValueMap | undefined,
  report: Report,
): void => {
  const controlJobs = asset.id === 'release-publication'
    ? ['authority', 'quality', 'assemble', 'publish']
    : asset.id === 'package-publication' ? ['publish'] : [];
  if (!canonical || controlJobs.length === 0) return;
  if (text.includes('<trusted-control-sha>')) add(report.mismatches, {
    path: `${asset.destination}:trusted-control-sha`,
    message: 'legacy trusted control SHA input is forbidden',
    settingLocation: asset.destination,
  });
  const entryJob = asset.id === 'release-publication' ? 'authority' : 'publish';
  for (const jobName of controlJobs) {
    const job = map(map(workflow.jobs)[jobName]);
    const canonicalJob = map(map(canonical.jobs)[jobName]);
    const jobPath = `${asset.destination}:jobs.${jobName}`;
    if ('container' in job || 'services' in job) add(report.mismatches, {
      path: jobPath,
      message: 'publication control cannot execute in a job container or service',
      settingLocation: asset.destination,
    });
    const steps = Array.isArray(job.steps) ? job.steps.map(map) : [];
    const canonicalSteps = Array.isArray(canonicalJob.steps) ? canonicalJob.steps.map(map) : [];
    const differences: Finding[] = [];
    if (jobName === entryJob) {
      compareCanonicalValue(canonicalSteps[0], steps[0], `${jobPath}.steps.0`, differences, new Set());
    } else {
      // The entry job owns admission; downstream control must retain its success dependency.
      for (const field of ['needs', 'if']) {
        compareCanonicalValue(canonicalJob[field], job[field], `${jobPath}.${field}`, differences, new Set());
      }
    }
    const checkoutIndex = steps.findIndex((step) =>
      typeof step.uses === 'string'
      && step.uses.startsWith('actions/checkout@')
      && map(step.with).repository === '${{ github.repository }}'
      && map(step.with).ref === '${{ github.workflow_sha }}');
    const canonicalCheckoutIndex = canonicalSteps.findIndex((step) =>
      typeof step.uses === 'string'
      && step.uses.startsWith('actions/checkout@')
      && map(step.with).ref === '${{ github.workflow_sha }}');
    if (checkoutIndex < 0) add(report.mismatches, {
      path: `${jobPath}.steps`,
      message: 'trusted control checkout must use the consumer repository and github.workflow_sha',
      settingLocation: asset.destination,
    });
    else {
      compareCanonicalValue(canonicalSteps[canonicalCheckoutIndex], steps[checkoutIndex], `${jobPath}.steps.${checkoutIndex}`, differences, new Set());
      compareCanonicalValue(canonicalSteps[canonicalCheckoutIndex + 1], steps[checkoutIndex + 1], `${jobPath}.steps.${checkoutIndex + 1}`, differences, new Set());
    }
    for (const difference of differences) add(report.mismatches, {
      ...difference,
      message: `publication control drift: ${difference.message}`,
      settingLocation: asset.destination,
    });
  }
};

const validateCopiedAssetContent = (
  root: string,
  assets: ManagedAsset[],
  report: Report,
): void => {
  for (const asset of assets.filter((candidate) => candidate.exactCopy)) {
    const appliedPath = inside(root, asset.path);
    if (!fs.existsSync(asset.sourcePath)) add(report.mismatches, {
      path: asset.path,
      message: 'canonical copyable asset is missing from the distribution',
    });
    else if (!fs.existsSync(appliedPath)) add(report.missingSettings, {
      path: asset.path,
      message: 'copyable asset is missing',
      settingLocation: asset.path,
    });
    else if (!realPathIsInside(root, appliedPath)) add(report.mismatches, {
      path: asset.path,
      message: 'copyable asset resolves outside the project root',
      settingLocation: asset.path,
    });
    else if (sha256(asset.sourcePath) !== sha256(appliedPath)) add(report.mismatches, {
      path: asset.path,
      message: 'copyable asset digest differs from the current canonical distribution',
      settingLocation: asset.path,
    });
  }
};

const validateAssetLock = (
  root: string,
  registry: RegistryData,
  assets: ManagedAsset[],
  report: Report,
  allowAdditionalAssets: boolean,
): void => {
  const lockPath = inside(root, registry.assetLock.path);
  if (!fs.existsSync(lockPath)) {
    add(report.missingSettings, {
      path: registry.assetLock.path,
      message: 'distribution integrity lock is missing',
      settingLocation: registry.assetLock.path,
    });
    return;
  }
  let lock: ValueMap;
  try {
    lock = map(JSON.parse(fs.readFileSync(lockPath, 'utf8')));
  } catch {
    add(report.mismatches, {
      path: registry.assetLock.path,
      message: 'distribution integrity lock is not valid JSON',
      settingLocation: registry.assetLock.path,
    });
    return;
  }
  if (lock.schemaVersion !== registry.assetLock.schemaVersion) add(report.mismatches, {
    path: `${registry.assetLock.path}:schemaVersion`,
    message: 'distribution integrity lock schemaVersion is unsupported',
    settingLocation: registry.assetLock.path,
  });
  if (lock.kind !== registry.assetLock.kind) add(report.mismatches, {
    path: `${registry.assetLock.path}:kind`,
    message: 'distribution integrity lock kind is unsupported',
    settingLocation: registry.assetLock.path,
  });
  if (typeof lock.sourceRevision !== 'string' || !FULL_SHA.test(lock.sourceRevision)) {
    add(report.mismatches, {
      path: `${registry.assetLock.path}:sourceRevision`,
      message: 'sourceRevision must be a full commit SHA',
      settingLocation: registry.assetLock.path,
    });
  }
  let generatedAtValid = typeof lock.generatedAt === 'string'
    && MINUTE_TIMESTAMP.test(lock.generatedAt);
  if (generatedAtValid) {
    try {
      generatedAtValid = minuteTimestamp(lock.generatedAt as string) === lock.generatedAt;
    } catch {
      generatedAtValid = false;
    }
  }
  if (!generatedAtValid) {
    add(report.mismatches, {
      path: `${registry.assetLock.path}:generatedAt`,
      message: 'generatedAt must be a valid UTC timestamp with minute precision',
      settingLocation: registry.assetLock.path,
    });
  }
  const entries = Array.isArray(lock.assets) ? lock.assets.map(map) : [];
  if (!Array.isArray(lock.assets)) add(report.missingSettings, {
    path: `${registry.assetLock.path}:assets`,
    message: 'distribution integrity assets are missing',
    settingLocation: registry.assetLock.path,
  });
  const byPath = new Map<string, ValueMap>();
  for (const entry of entries) {
    if (typeof entry.path !== 'string' || entry.path === '' || byPath.has(entry.path)) {
      add(report.mismatches, {
        path: `${registry.assetLock.path}:assets`,
        message: 'distribution integrity asset paths must be unique non-empty strings',
        settingLocation: registry.assetLock.path,
      });
      continue;
    }
    byPath.set(entry.path, entry);
  }
  const expectedPaths = new Set(assets.map((asset) => asset.path));
  for (const observed of byPath.keys()) {
    if (!allowAdditionalAssets && !expectedPaths.has(observed)) add(report.mismatches, {
      path: observed,
      message: 'distribution integrity lock contains an unmanaged asset',
      settingLocation: registry.assetLock.path,
    });
  }
  for (const asset of assets) {
    const entry = byPath.get(asset.path);
    if (!entry) {
      add(report.missingSettings, {
        path: asset.path,
        message: 'asset is missing from the distribution integrity lock',
        settingLocation: registry.assetLock.path,
      });
      continue;
    }
    const appliedPath = inside(root, asset.path);
    if (!fs.existsSync(asset.sourcePath) || !fs.existsSync(appliedPath)) continue;
    const canonicalDigest = sha256(asset.sourcePath);
    const appliedDigest = sha256(appliedPath);
    if (typeof entry.canonicalSha256 !== 'string' || !SHA256.test(entry.canonicalSha256)
      || entry.canonicalSha256 !== canonicalDigest) add(report.mismatches, {
      path: asset.path,
      message: 'canonical digest does not match the current distribution',
      settingLocation: registry.assetLock.path,
    });
    if (typeof entry.appliedSha256 !== 'string' || !SHA256.test(entry.appliedSha256)
      || entry.appliedSha256 !== appliedDigest) add(report.mismatches, {
      path: asset.path,
      message: 'applied digest does not match the installed asset',
      settingLocation: registry.assetLock.path,
    });
  }
  report.evidence.push(`${registry.assetLock.path}: source ${String(lock.sourceRevision ?? '')}`);
  report.evidence.push(`${registry.assetLock.path}: ${assets.length} asset digests inspected`);
};

const walk = (node: unknown, visit: (key: string, value: unknown) => void): void => {
  if (Array.isArray(node)) {
    node.forEach((value) => walk(value, visit));
    return;
  }
  if (!isMap(node)) return;
  for (const [key, value] of Object.entries(node)) {
    visit(key, value);
    walk(value, visit);
  }
};

const on = (workflow: ValueMap): ValueMap => map(workflow.on);

const hasTrigger = (workflow: ValueMap, trigger: string): boolean =>
  Object.prototype.hasOwnProperty.call(on(workflow), trigger);

const uses = (workflow: unknown): string[] => {
  const result: string[] = [];
  walk(workflow, (key, value) => {
    if (key === 'uses' && typeof value === 'string') result.push(value);
  });
  return result;
};

const actionUses = (workflow: unknown): string[] => {
  const result: string[] = [];
  const jobs = map(isMap(workflow) ? workflow.jobs : undefined);
  for (const job of Object.values(jobs)) {
    const steps = map(job).steps;
    if (!Array.isArray(steps)) continue;
    for (const step of steps) {
      const reference = map(step).uses;
      if (typeof reference === 'string') result.push(reference);
    }
  }
  return result;
};

const localWorkflows = (workflow: unknown): string[] =>
  uses(workflow).filter((value) => value.startsWith('./.github/workflows/')).map((value) => value.slice(2));


const validateNoProjectRuntime = (root: string, report: Report): void => {
  const runtimePath = path.join(root, '.ci/runtime');
  if (!fs.existsSync(runtimePath)) return;
  add(report.mismatches, {
    path: '.ci/runtime',
    message: 'project-local CI runtime is obsolete; prepare dependencies in isolated tool state and remove this directory',
    settingLocation: '.ci/runtime',
  });
};

const validateProviderActionPinCompanion = (
  root: string,
  parsed: Map<string, ValueMap>,
  registry: RegistryData,
  report: Report,
): void => {
  const companionPath = registry.providerActionPinCompanionPath;
  if (!companionPath || registry.providerActionPinCompanionComparison !== 'required') return;
  const used = new Set<string>();
  for (const workflow of parsed.values()) {
    for (const value of actionUses(workflow)) {
      if (value.startsWith('./')) continue;
      const target = value.split('@')[0];
      const repository = target.split('/').slice(0, 2).join('/');
      if (repository === registry.actionRepository) continue;
      if (registry.approvedProviderActionPins.has(repository)) used.add(repository);
    }
  }
  if (used.size === 0) return;
  const absolute = path.join(root, companionPath);
  if (!fs.existsSync(absolute)) {
    add(report.missingSettings, {
      path: companionPath,
      message: 'approved pin companion is missing',
      settingLocation: companionPath,
    });
    return;
  }
  const document = map(parseYaml(fs.readFileSync(absolute, 'utf8'), companionPath, report));
  for (const action of [...used].sort()) {
    const entry = map(document[action]);
    if (Object.keys(entry).length === 0) {
      add(report.mismatches, {
        path: `${companionPath}:${action}`,
        message: 'approved pin companion entry is missing',
        settingLocation: companionPath,
      });
      continue;
    }
    for (const field of registry.providerActionPinFields) {
      const expected = registry.approvedProviderActionEntries.get(action)?.[field];
      if (expected === undefined) continue;
      if (String(entry[field] ?? '') !== expected) add(report.mismatches, {
        path: `${companionPath}:${action}.${field}`,
        message: 'approved pin companion does not match the registry',
        settingLocation: companionPath,
      });
    }
  }
};

const validateCommon = (
  root: string,
  displayPath: string,
  text: string,
  workflow: ValueMap,
  report: Report,
  registry: RegistryData,
  excludedReferences: ReadonlySet<string> = new Set(),
): void => {
  if (PLACEHOLDER.test(text)) add(report.missingSettings, {
    path: displayPath,
    message: 'workflow contains unresolved placeholders',
    settingLocation: displayPath,
  });
  walk(workflow, (key, value) => {
    if (key === 'runs-on' && typeof value === 'string' && value.endsWith('-latest')) {
      add(report.mismatches, {
        path: `${displayPath}:runs-on`,
        message: 'runner must be versioned',
        settingLocation: displayPath,
      });
    }
  });
  for (const value of uses(workflow).filter((item) => !item.startsWith('./'))) {
    const separator = value.lastIndexOf('@');
    const action = separator < 0 ? value : value.slice(0, separator);
    const ref = separator < 0 ? '' : value.slice(separator + 1);
    if (!FULL_SHA.test(ref)) add(report.mismatches, {
      path: `${displayPath}:uses.${action}`,
      message: 'external Action must use a full commit SHA',
      settingLocation: displayPath,
    });
  }
  // provider Action の承認 pin 規則は step の Action 参照だけに適用する。
  // job の reusable workflow 参照は Action runtime を持たないため対象外とする。
  for (const value of actionUses(workflow)) {
    const separator = value.lastIndexOf('@');
    const action = separator < 0 ? value : value.slice(0, separator);
    const ref = separator < 0 ? '' : value.slice(separator + 1);
    if (!FULL_SHA.test(ref)) continue;
    const segments = action.split('/');
    const repository = segments.slice(0, 2).join('/');
    if (repository === registry.actionRepository) continue;
    const approved = registry.approvedProviderActionPins.get(repository);
    if (approved === undefined) add(report.mismatches, {
      path: `${displayPath}:uses.${action}`,
      message: 'provider Action is not declared in the approved pin registry',
      settingLocation: displayPath,
    });
    else if (ref !== approved) add(report.mismatches, {
      path: `${displayPath}:uses.${action}`,
      message: 'provider Action does not use the approved pin',
      settingLocation: displayPath,
    });
  }
  for (const job of Object.values(map(workflow.jobs))) {
    for (const step of Array.isArray(map(job).steps) ? map(job).steps as unknown[] : []) {
      const value = map(step);
      if (typeof value.uses !== 'string' || !value.uses.startsWith(`${registry.actionRepository}/actions/ci-quality-toolchain@`)) continue;
      const expected = {
        'language-profile': '${{ env.CI_LANGUAGE_PROFILE }}',
        'toolchain-version': '${{ env.CI_TOOLCHAIN_VERSION }}',
        'uv-version': '${{ env.CI_UV_VERSION }}',
        'cargo-audit-version': '${{ env.CI_CARGO_AUDIT_VERSION }}',
      };
      const inputs = map(value.with);
      if (Object.keys(inputs).length !== Object.keys(expected).length
        || Object.entries(expected).some(([name, expression]) => inputs[name] !== expression)) add(report.mismatches, {
        path: `${displayPath}:with.ci-quality-toolchain`, message: 'quality toolchain must bind its four explicit workflow settings', settingLocation: displayPath,
      });
    }
  }
  for (const reference of findWorkflowAssetReferences(root, text, excludedReferences)) {
    try {
      const absolute = inside(root, reference);
      if (!fs.existsSync(absolute)) add(report.missingSettings, {
        path: reference,
        message: 'workflow asset reference is missing',
        settingLocation: displayPath,
      });
      else if (!realPathIsInside(root, absolute)) add(report.mismatches, {
        path: reference,
        message: 'workflow asset resolves outside the project root',
        settingLocation: displayPath,
      });
    } catch (error) {
      add(report.mismatches, {
        path: reference,
        message: error instanceof Error ? error.message : 'invalid workflow asset path',
        settingLocation: displayPath,
      });
    }
  }
};

const TRIGGERS_BY_ASSET: Record<string, string[]> = {
  'release-request-tag': ['push'],
  'release-publication-request': ['workflow_dispatch'],
  'release-publication-caller': ['workflow_run'],
  'release-publication': ['workflow_call'],
  'package-publication-caller': ['workflow_run'],
  'package-publication-request': ['workflow_dispatch'],
};

const TRIGGERS_BY_PRESET: Record<string, string[]> = {
  'quality-gate': ['pull_request', 'push'],
};

const validateTrigger = (
  preset: string,
  assetId: string,
  workflow: ValueMap,
  displayPath: string,
  report: Report,
): void => {
  const required = TRIGGERS_BY_ASSET[assetId] ?? TRIGGERS_BY_PRESET[preset] ?? ['workflow_call'];
  for (const trigger of required) {
    if (!hasTrigger(workflow, trigger)) add(report.mismatches, {
      path: `${displayPath}:on.${trigger}`,
      message: `required trigger ${trigger} is missing`,
      settingLocation: displayPath,
    });
  }
  if (preset === 'quality-gate' && strings(map(on(workflow).push).branches).length === 0) {
    add(report.missingSettings, {
      path: `${displayPath}:on.push.branches`,
      message: 'quality push trigger must select a protected branch',
      settingLocation: displayPath,
    });
  }
  if (assetId === 'release-request-tag' && strings(map(on(workflow).push).tags).length === 0) {
    add(report.missingSettings, {
      path: `${displayPath}:on.push.tags`,
      message: 'tag request trigger must select a tag pattern',
      settingLocation: displayPath,
    });
  }
  if (assetId === 'release-publication-caller' || assetId === 'package-publication-caller') {
    const publicationKind = assetId === 'release-publication-caller' ? 'release' : 'package';
    const forbiddenTriggers = ['workflow_dispatch', 'workflow_call', 'push', 'pull_request'];
    for (const forbidden of forbiddenTriggers) {
      if (hasTrigger(workflow, forbidden)) add(report.mismatches, {
        path: `${displayPath}:on.${forbidden}`,
        message: `trusted ${publicationKind} publication caller must only start from workflow_run`,
        settingLocation: displayPath,
      });
    }
  }
  if (assetId === 'release-publication') {
    for (const forbidden of ['workflow_dispatch', 'workflow_run', 'push', 'pull_request']) {
      if (hasTrigger(workflow, forbidden)) add(report.mismatches, {
        path: `${displayPath}:on.${forbidden}`,
        message: 'trusted release publication workflow must only be invoked through workflow_call',
        settingLocation: displayPath,
      });
    }
  }
};


const permissionRank = (value: unknown): number => value === 'write' ? 2 : value === 'read' ? 1 : 0;

const effectivePermissions = (workflow: ValueMap, job: ValueMap): ValueMap =>
  Object.prototype.hasOwnProperty.call(job, 'permissions')
    ? map(job.permissions)
    : map(workflow.permissions);

const inspectPackagePreparation = (
  context: InspectionContext, asset: WorkflowAsset, workflow: ValueMap, observedActions: Set<string>,
): void => {
  if (asset.id !== 'package-publication-caller') return;
  const { root, registry, report, actionByPath } = context;
  const binding = registry.packagePreparationReusableWorkflow;
  if (!binding) {
    add(report.mismatches, { path: asset.destination, message: 'package preparation binding is missing' });
    return;
  }
  const call = map(map(workflow.jobs).prepare);
  const expectedRef = binding.status === 'available' ? binding.exactRef : binding.referencePlaceholder;
  if (call.uses !== `${registry.actionRepository}/${binding.source}@${expectedRef}`) add(report.mismatches, {
    path: `${asset.destination}:jobs.prepare.uses`, message: 'package preparation reusable workflow ref does not match the registry',
  });
  if (binding.status !== 'available') add(report.missingSettings, {
    path: `${asset.destination}:jobs.prepare.uses`, message: 'package preparation reusable workflow is pending-release; deployment is forbidden',
  });
  const source = path.resolve(SKILL_ROOT, binding.source);
  if (!source.startsWith(`${SKILL_ROOT}${path.sep}`) || !fs.existsSync(source) || !realPathIsInside(SKILL_ROOT, source)) {
    add(report.mismatches, { path: binding.source, message: 'fixed package preparation workflow source is missing or outside the provider root' });
    return;
  }
  const callee = map(parseYaml(fs.readFileSync(source, 'utf8'), binding.source, report));
  const definitions = map(map(on(callee).workflow_call).inputs);
  for (const [name, value] of Object.entries(map(call.with))) {
    if (!(name in definitions) || typeof value !== map(definitions[name]).type) add(report.mismatches, {
      path: `${asset.destination}:jobs.prepare.with.${name}`, message: 'package preparation input is undeclared or has the wrong type',
    });
  }
  for (const [name, definition] of Object.entries(definitions)) {
    if (map(definition).required === true && !(name in map(call.with))) add(report.missingSettings, {
      path: `${asset.destination}:jobs.prepare.with.${name}`, message: 'required package preparation input is missing',
    });
  }
  validateCommon(root, `${asset.destination}:prepare`, JSON.stringify(callee), callee, report, registry);
  for (const value of actionUses(callee)) {
    if (!value.startsWith(`${registry.actionRepository}/`)) continue;
    const separator = value.lastIndexOf('@');
    const target = actionByPath.get(value.slice(0, separator));
    if (!target || !target.workflows.includes('package-preparation')) add(report.mismatches, {
      path: binding.source, message: 'package preparation Action is not registered or mapped',
    });
    else {
      observedActions.add(target.id);
      const ref = target.status === 'pending-release' ? registry.pendingActionRef : registry.actionExactRef;
      if (value.slice(separator + 1) !== ref) add(report.mismatches, {
        path: binding.source, message: 'package preparation Action ref does not match the registry',
      });
    }
  }
};

const inspectWorkflowAsset = (
  context: InspectionContext,
  preset: Preset,
  asset: WorkflowAsset,
  observedActions: Set<string>,
): void => {
  const { root, registry, actionByPath, parsed, report } = context;
  const absolute = path.join(root, asset.destination);
  if (!fs.existsSync(absolute)) {
    add(report.missingSettings, {
      path: asset.destination,
      message: 'canonical workflow is missing',
      settingLocation: asset.destination,
    });
    return;
  }
  if (!realPathIsInside(root, absolute)) {
    add(report.mismatches, {
      path: asset.destination,
      message: 'canonical workflow resolves outside the project root',
      settingLocation: asset.destination,
    });
    return;
  }
  report.inspectedWorkflows.push(asset.destination);
  const text = fs.readFileSync(absolute, 'utf8');
  const workflow = map(parseYaml(text, asset.destination, report));
  parsed.set(asset.destination, workflow);
  const canonical = validateCanonicalWorkflow(asset, workflow, registry, report);
  validatePublicationControl(asset, text, workflow, canonical, report);
  validateCommon(
    root,
    asset.destination,
    text,
    workflow,
    report,
    registry,
    inactiveConditionalEntrypoints(root, registry, preset),
  );
  validateTrigger(preset.id, asset.id, workflow, asset.destination, report);
  inspectPackagePreparation(context, asset, workflow, observedActions);
  const publication = publicationBinding(asset.id, registry);
  const execution = resolvePublicationWorkflow(resolveQualityWorkflow(workflow, registry, report), registry, report);
  const executionId = publication ? asset.id.replace(/-caller$/, '') : asset.id;
  if (publication) {
    const call = map(map(workflow.jobs).publish);
    const expectedRef = publication.status === 'available' ? publication.exactRef : publication.referencePlaceholder;
    if (call.uses !== `${registry.actionRepository}/${publication.source}@${expectedRef}`) add(report.mismatches, {
      path: `${asset.destination}:jobs.publish.uses`, message: 'publication reusable workflow ref does not match the registry', settingLocation: asset.destination,
    });
    if (publication.status !== 'available') add(report.missingSettings, {
      path: `${asset.destination}:jobs.publish.uses`, message: 'publication reusable workflow is pending-release; deployment is forbidden', settingLocation: asset.destination,
    });
    if (execution !== workflow) {
      const definitions = map(map(map(execution.on).workflow_call).inputs);
      const runtimeInputs = new Set(executionId === 'release-publication'
        ? ['request_run_id', 'publication_request_run_id']
        : ['package_handoff_run_id', 'source_sha', 'version', 'target_identity', 'package_artifact_id']);
      for (const [name, value] of Object.entries(map(call.with))) {
        if (!(name in definitions) || !(typeof value === map(definitions[name]).type
          || runtimeInputs.has(name) && typeof value === 'string' && /^\$\{\{.*\}\}$/.test(value))) add(report.mismatches, {
          path: `${asset.destination}:jobs.publish.with.${name}`, message: 'publication reusable workflow input is undeclared or has the wrong type', settingLocation: asset.destination,
        });
        if (!runtimeInputs.has(name) && typeof value === 'string' && value.includes('${{')) add(report.mismatches, {
          path: `${asset.destination}:jobs.publish.with.${name}`, message: 'publication owner configuration must be static', settingLocation: asset.destination,
        });
      }
      const runner = map(call.with).runner;
      if (typeof runner !== 'string' || runner === '' || runner.endsWith('-latest') || runner.includes('${{')) add(report.mismatches, {
        path: `${asset.destination}:jobs.publish.with.runner`, message: 'publication runner must be a static versioned label', settingLocation: asset.destination,
      });
      const virtualAsset = { id: executionId, destination: `.github/workflows/${executionId}.yml`, source: publication.source };
      parsed.set(virtualAsset.destination, execution);
      const provider = map(parseYaml(fs.readFileSync(canonicalSourcePath(publication.source, SKILL_ROOT), 'utf8'), publication.source, report));
      validatePublicationControl(virtualAsset, JSON.stringify(execution), execution, provider, report);
      validateCommon(root, `${asset.destination}:reusable`, JSON.stringify(execution), execution, report, registry,
        inactiveConditionalEntrypoints(root, registry, preset));
    }
  }
  const binding = asset.id === 'quality-gate' ? registry.qualityReusableWorkflow
    : asset.id === 'quality-gate-platforms' ? registry.qualityPlatformsReusableWorkflow : undefined;
  if (binding) {
    const jobId = asset.id === 'quality-gate-platforms' ? 'platforms' : 'quality';
    const label = asset.id === 'quality-gate-platforms' ? 'platform' : 'quality';
    const call = map(map(workflow.jobs)[jobId]);
    const expectedRef = binding.status === 'available' ? binding.exactRef : binding.referencePlaceholder;
    if (call.uses !== `${registry.actionRepository}/${binding.source}@${expectedRef}`) add(report.mismatches, {
      path: `${asset.destination}:jobs.${jobId}.uses`, message: `${label} reusable workflow ref does not match the registry`, settingLocation: asset.destination,
    });
    if (binding.status !== 'available') add(report.missingSettings, {
      path: `${asset.destination}:jobs.${jobId}.uses`, message: `${label} reusable workflow is pending-release; deployment is forbidden`, settingLocation: asset.destination,
    });
    const runner = map(call.with).runner;
    if (typeof runner !== 'string' || runner === '' || runner.endsWith('-latest') || runner.includes('${{')) add(report.mismatches, {
      path: `${asset.destination}:jobs.${jobId}.with.runner`, message: `${label} runner must be a static versioned label`, settingLocation: asset.destination,
    });
    if (asset.id === 'quality-gate') {
      const jqVersion = map(call.with)['jq-version'];
      if (jqVersion !== undefined && jqVersion !== ''
        && (typeof jqVersion !== 'string' || !/^\d+\.\d+(?:\.\d+)?$/.test(jqVersion))) add(report.mismatches, {
        path: `${asset.destination}:jobs.quality.with.jq-version`,
        message: 'quality jq version must be empty or an exact version',
        settingLocation: asset.destination,
      });
    }
    if (execution !== workflow) {
      const definitions = map(map(map(execution.on).workflow_call).inputs);
      for (const [name, value] of Object.entries(map(call.with))) if (!(name in definitions) || typeof value !== map(definitions[name]).type) add(report.mismatches, {
        path: `${asset.destination}:jobs.${jobId}.with.${name}`, message: `${label} reusable workflow input is undeclared or has the wrong type`, settingLocation: asset.destination,
      });
      for (const [name, definition] of Object.entries(definitions)) if (map(definition).required === true && !(name in map(call.with))) add(report.missingSettings, {
        path: `${asset.destination}:jobs.${jobId}.with.${name}`, message: `required ${label} reusable workflow input is missing`, settingLocation: asset.destination,
      });
      validateCommon(root, `${asset.destination}:reusable`, JSON.stringify(execution), execution, report, registry);
    }
  }
  for (const value of new Set([...actionUses(workflow), ...actionUses(execution)].filter((item) =>
    item.startsWith(`${registry.actionRepository}/`)))) {
    const separator = value.lastIndexOf('@');
    const actionName = separator < 0 ? value : value.slice(0, separator);
    const ref = separator < 0 ? '' : value.slice(separator + 1);
    const target = actionByPath.get(actionName);
    if (!target) {
      add(report.mismatches, {
        path: `${asset.destination}:uses.${actionName}`,
        message: 'a3 Action is not registered',
        settingLocation: asset.destination,
      });
      continue;
    }
    observedActions.add(target.id);
    const expectedRef = target.status === 'pending-release' ? registry.pendingActionRef : registry.actionExactRef;
    if (ref !== expectedRef) add(report.mismatches, {
      path: `${asset.destination}:uses.${actionName}`,
      message: 'a3 Action ref does not match the registry',
      settingLocation: asset.destination,
    });
    if (!target.workflows.includes(actionUses(workflow).includes(value) ? asset.id : executionId)) add(report.mismatches, {
      path: `${asset.destination}:uses.${actionName}`,
      message: 'a3 Action is not mapped to this workflow',
      settingLocation: asset.destination,
    });
  }
  for (const [jobName, jobValue] of Object.entries(map(execution.jobs))) {
    const job = map(jobValue);
    const writePermissions = Object.entries(effectivePermissions(execution, job))
      .filter(([, level]) => level === 'write')
      .map(([permission]) => permission);
    if (writePermissions.length === 0) continue;
    const steps = Array.isArray(job.steps) ? job.steps.map(map) : [];
    for (const [stepIndex, step] of steps.entries()) {
      if (typeof step.uses !== 'string'
        || !step.uses.startsWith(`${registry.actionRepository}/`)) continue;
      const separator = step.uses.lastIndexOf('@');
      const actionName = separator < 0 ? step.uses : step.uses.slice(0, separator);
      const target = actionByPath.get(actionName);
      if (!target) continue;
      const privilegedJob = `${executionId}/${jobName}`;
      if (!target.privilegedJobs.includes(privilegedJob)) add(report.mismatches, {
        path: `${asset.destination}:jobs.${jobName}.steps.${stepIndex}.uses`,
        message: `a3 Action is not allowlisted for write permissions: ${writePermissions.join(', ')}`,
        settingLocation: asset.destination,
      });
    }
  }
  for (const local of localWorkflows(workflow)) {
    if (!fs.existsSync(path.join(root, local))) add(report.missingSettings, {
      path: local,
      message: 'local reusable workflow is missing',
      settingLocation: asset.destination,
    });
  }
};

const remapPublicationDiagnostics = (parsed: Map<string, ValueMap>, registry: RegistryData, report: Report): void => {
  for (const kind of ['release', 'package']) {
    const callerPath = `.github/workflows/${kind}-publication-caller.yml`;
    const caller = parsed.get(callerPath);
    const binding = publicationBinding(`${kind}-publication-caller`, registry);
    if (!caller || !binding || !parsed.has(`.github/workflows/${kind}-publication.yml`)) continue;
    const source = canonicalSourcePath(binding.source, SKILL_ROOT);
    const provider = map(parseYaml(fs.readFileSync(source, 'utf8'), binding.source));
    const envInputs = new Map(Object.entries(map(provider.env)).flatMap(([key, value]) => {
      const match = typeof value === 'string' ? value.match(/^\$\{\{ inputs\.([a-z0-9-]+) \}\}$/) : undefined;
      return match ? [[key, match[1]] as const] : [];
    }));
    const virtualPath = `.github/workflows/${kind}-publication.yml`;
    for (const finding of [...report.missingSettings, ...report.mismatches]) {
      for (const prefix of [virtualPath, callerPath]) {
        if (!finding.path.startsWith(`${prefix}:env.`)) continue;
        const envKey = finding.path.slice(`${prefix}:env.`.length);
        const input = envInputs.get(envKey);
        if (input) finding.path = `${callerPath}:jobs.publish.with.${input}`;
      }
      if (finding.path.startsWith(`${virtualPath}:`)) finding.path =
        `${callerPath}:jobs.publish.uses:provider.${finding.path.slice(virtualPath.length + 1)}`;
      if (finding.settingLocation === virtualPath) finding.settingLocation = callerPath;
    }
  }
};

export { validateCopiedAssetContent, validateAssetLock, walk, on, uses, actionUses, localWorkflows, validateNoProjectRuntime, validateProviderActionPinCompanion, validateCommon, permissionRank, effectivePermissions, inspectWorkflowAsset, remapPublicationDiagnostics };
