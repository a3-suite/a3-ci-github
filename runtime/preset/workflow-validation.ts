import fs from 'node:fs';
import path from 'node:path';
import { FULL_SHA, minuteTimestamp } from './ci-asset-lock.ts';
import { SKILL_ROOT, add, canonicalSourcePath, inactiveConditionalEntrypoints, isMap, map, parseYaml, strings } from './ci-preset-assets.ts';
import type { Finding, ManagedAsset, Preset, RegistryData, TriggerExtensionRule, ValueMap, WorkflowAsset } from './ci-preset-assets.ts';
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

const validateWorkflowIdentity = (
  asset: WorkflowAsset,
  text: string,
  workflow: ValueMap,
  canonical: ValueMap | undefined,
  report: Report,
): void => {
  if (!canonical) return;
  const canonicalJobs = map(canonical.jobs);
  const identityJobs = Object.entries(canonicalJobs).filter(([, value]) => {
    const candidateSteps = map(value).steps;
    const steps = Array.isArray(candidateSteps) ? candidateSteps : [];
    return map(steps[0]).id === 'workflow-identity';
  });
  if (identityJobs.length === 0) return;
  if (text.includes('<trusted-control-sha>')) add(report.mismatches, {
    path: `${asset.destination}:trusted-control-sha`,
    message: 'legacy trusted control SHA input is forbidden',
    settingLocation: asset.destination,
  });
  for (const [jobName, canonicalJobValue] of identityJobs) {
    const job = map(map(workflow.jobs)[jobName]);
    const candidateCanonicalSteps = map(canonicalJobValue).steps;
    const canonicalSteps = Array.isArray(candidateCanonicalSteps) ? candidateCanonicalSteps : [];
    const expectedEnv = map(map(canonicalSteps[0]).env);
    const jobPath = `${asset.destination}:jobs.${jobName}`;
    if ('container' in job || 'services' in job) add(report.mismatches, {
      path: jobPath,
      message: 'workflow identity gate cannot precede a job container or service',
      settingLocation: asset.destination,
    });
    const steps = Array.isArray(job.steps) ? job.steps.map(map) : [];
    const gate = steps[0] ?? {};
    const expectedGate = map(canonicalSteps[0]);
    if (gate.id !== 'workflow-identity') {
      add(report.mismatches, {
        path: `${jobPath}.steps.0`,
        message: 'workflow identity gate must be the first step',
        settingLocation: asset.destination,
      });
      continue;
    }
    if (typeof expectedGate.uses === 'string') {
      if (gate.uses !== expectedGate.uses) add(report.mismatches, {
        path: `${jobPath}.steps.0.uses`,
        message: 'workflow identity Action binding is missing or incorrect',
        settingLocation: asset.destination,
      });
      const actualInputs = map(gate.with);
      for (const [name, value] of Object.entries(map(expectedGate.with))) {
        if (actualInputs[name] !== value) add(report.mismatches, {
          path: `${jobPath}.steps.0.with.${name}`,
          message: 'workflow identity Action input is missing or incorrect',
          settingLocation: asset.destination,
        });
      }
    } else {
      if (typeof gate.run !== 'string') add(report.mismatches, {
        path: `${jobPath}.steps.0`,
        message: 'workflow identity inline gate must execute its verification script',
        settingLocation: asset.destination,
      });
      const env = map(gate.env);
      for (const [name, value] of Object.entries(expectedEnv)) {
        if (env[name] !== value) add(report.mismatches, {
          path: `${jobPath}.steps.0.env.${name}`,
          message: 'workflow identity context binding is missing or incorrect',
          settingLocation: asset.destination,
        });
      }
    }
    const checkoutIndex = steps.findIndex((step) =>
      typeof step.uses === 'string'
      && step.uses.startsWith('actions/checkout@')
      && map(step.with).ref === '${{ steps.workflow-identity.outputs.sha }}');
    if (checkoutIndex < 0) {
      add(report.mismatches, {
        path: `${jobPath}.steps`,
        message: 'trusted control checkout must use the verified workflow identity SHA',
        settingLocation: asset.destination,
      });
      continue;
    }
    const verification = steps[checkoutIndex + 1] ?? {};
    if (typeof verification.run !== 'string') add(report.mismatches, {
      path: `${jobPath}.steps.${checkoutIndex + 1}`,
      message: 'trusted control checkout must be followed immediately by a verification step',
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
  validateWorkflowIdentity(asset, text, workflow, canonical, report);
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
  for (const value of uses(workflow).filter((item) =>
    item.startsWith(`${registry.actionRepository}/`))) {
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
    if (ref !== registry.actionExactRef) add(report.mismatches, {
      path: `${asset.destination}:uses.${actionName}`,
      message: 'a3 Action ref does not match the registry',
      settingLocation: asset.destination,
    });
    if (!target.workflows.includes(asset.id)) add(report.mismatches, {
      path: `${asset.destination}:uses.${actionName}`,
      message: 'a3 Action is not mapped to this workflow',
      settingLocation: asset.destination,
    });
  }
  for (const [jobName, jobValue] of Object.entries(map(workflow.jobs))) {
    const job = map(jobValue);
    const writePermissions = Object.entries(effectivePermissions(workflow, job))
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
      const privilegedJob = `${asset.id}/${jobName}`;
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

export { validateCopiedAssetContent, validateAssetLock, walk, on, uses, actionUses, localWorkflows, validateNoProjectRuntime, validateProviderActionPinCompanion, validateCommon, permissionRank, effectivePermissions, inspectWorkflowAsset };
