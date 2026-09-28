#!/usr/bin/env -S node --import tsx

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validatePlatformManifest as validatePlatformManifestContent } from './validate-platform-manifest.ts';
import { minuteTimestamp, writeAssetLock, type AssetLock } from './ci-asset-lock.ts';
import {
  add,
  adapterBundleAssets,
  canonicalSourcePath,
  inactiveConditionalEntrypoints,
  installedPresetWorkflows,
  isMap,
  loadRegistry,
  managedAssets,
  map,
  normalizeAsset,
  parseYaml,
  selectPresets,
  standardQualityBundles,
  strings,
  SOURCE_ROOT,
  SKILL_ROOT,
  valueAtPath,
  type ActionTarget,
  type Finding,
  type ManagedAsset,
  type Preset,
  type RegistryData,
  type TriggerExtensionRule,
  type ValueMap,
  type WorkflowAsset,
} from './ci-preset-assets.ts';

export {
  canonicalSourcePath,
  collectProviderStaticValidationConfigPaths,
  isSafeProviderConfigPath,
} from './ci-preset-assets.ts';

type Status = 'success' | 'failed';
export type SemanticCandidate = {
  kind: 'unmanaged-workflow' | 'unreachable-asset' | 'unclassified-directory-asset'
    | 'action-local-overlap';
  path: string;
  relatedPaths: string[];
  message: string;
};
type InspectionContext = {
  root: string;
  registry: RegistryData;
  actionByPath: Map<string, ActionTarget>;
  parsed: Map<string, ValueMap>;
  report: Report;
};

export type Report = {
  schemaVersion: '1';
  phase: 'provider-preflight';
  status: Status;
  inspectedPresets: string[];
  excludedPresets: string[];
  inspectedWorkflows: string[];
  excludedWorkflows: string[];
  missingSettings: Finding[];
  mismatches: Finding[];
  evidence: string[];
  semanticReviewRequired: boolean;
  semanticCandidates: SemanticCandidate[];
};

const CI_SCRIPT_CONTRACT_PATH = path.resolve(
  SOURCE_ROOT,
  'skills/ci-github/references/ci-script-contracts.reference.yml',
);
const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MINUTE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/;
const PLACEHOLDER = /<[A-Za-z][A-Za-z0-9._-]*>/;
const WORKFLOW_ASSET = /(?:\.ci-base\/)?(\.ci\/(?:scripts|provider|trusted|runtime)\/[A-Za-z0-9._/-]+)/g;
const LOCAL_ASSET = /(?:\$?\{?)(script_dir|runtime_dir)\}?\/([A-Za-z0-9._/-]+)/g;
const POWERSHELL_LOCAL_ASSET = /\$PSScriptRoot\s+['"]([A-Za-z0-9._/-]+)['"]/g;
const RELATIVE_IMPORT = /\b(?:from|import|require)\s*(?:\(\s*)?['"](\.{1,2}\/[^'"]+)['"]/g;

const PYTHON_IMPORT = /(?:^|\n)\s*(?:from\s+([A-Za-z_][A-Za-z0-9_.]*)\s+import|import\s+([A-Za-z_][A-Za-z0-9_.]*))/g;

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

const supplementalAdapterCommand = (
  phaseName: string,
  argumentValues: Record<string, string>,
  report: Report,
): string | undefined => {
  if (!fs.existsSync(CI_SCRIPT_CONTRACT_PATH)) {
    add(report.missingSettings, {
      path: CI_SCRIPT_CONTRACT_PATH,
      message: 'CI script contract is missing',
    });
    return undefined;
  }
  const definitions = map(parseYaml(
    fs.readFileSync(CI_SCRIPT_CONTRACT_PATH, 'utf8'),
    CI_SCRIPT_CONTRACT_PATH,
    report,
  ));
  const contract = (Array.isArray(definitions.contracts) ? definitions.contracts : [])
    .map(map)
    .find((item) => item.id === 'release-supplemental-asset-build-scripts');
  const phase = map(map(map(contract?.adapterInterface).phases)[phaseName]);
  const subcommand = phase.subcommand;
  const argumentsFromContract = strings(phase.arguments);
  const resolvedArguments = argumentsFromContract.map((argument) => argumentValues[argument]);
  if (typeof subcommand !== 'string' || subcommand === ''
    || argumentsFromContract.length === 0
    || resolvedArguments.some((argument) => argument === undefined)) {
    add(report.mismatches, {
      path: CI_SCRIPT_CONTRACT_PATH,
      message: `supplemental asset adapter phase ${phaseName} is invalid`,
    });
    return undefined;
  }
  return [
    '.ci/scripts/ci-release-supplemental-asset.sh',
    subcommand,
    ...resolvedArguments,
  ].join(' ');
};

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
const inside = (root: string, relativePath: string): string => {
  const absolute = path.resolve(root, relativePath);
  const relative = path.relative(path.resolve(root), absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('path escapes repository root');
  return absolute;
};
const realPathIsInside = (root: string, absolutePath: string): boolean => {
  const realRoot = fs.realpathSync(root);
  const realPath = fs.realpathSync(absolutePath);
  const relative = path.relative(realRoot, realPath);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const sha256 = (absolutePath: string): string => createHash('sha256')
  .update(fs.readFileSync(absolutePath))
  .digest('hex');

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

const stripComment = (line: string): string => {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && quote === '"') {
      escaped = true;
      continue;
    }
    if ((character === "'" || character === '"') && (!quote || quote === character)) {
      quote = quote ? undefined : character;
      continue;
    }
    if (!quote && (character === '#' || (character === '/' && line[index + 1] === '/'))
      && (index === 0 || /\s/.test(line[index - 1]))) return line.slice(0, index);
  }
  return line;
};
const executableText = (text: string): string => text
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('/*') && !line.trimStart().startsWith('*'))
  .map(stripComment)
  .join('\n');
const directAssets = (text: string): Set<string> => {
  const result = new Set<string>();
  for (const match of executableText(text).matchAll(WORKFLOW_ASSET)) {
    const normalized = normalizeAsset(match[1]);
    if (normalized) result.add(normalized);
  }
  return result;
};
const indirectAssets = (
  root: string,
  initial: Set<string>,
  excludedReferences: ReadonlySet<string>,
): Set<string> => {
  const result = new Set(initial);
  const queue = [...initial];
  const scanned = new Set<string>();
  while (queue.length > 0) {
    const reference = queue.shift() as string;
    if (scanned.has(reference) || !/\.(?:sh|ps1|py|ts|js|mjs|cjs)$/.test(reference)) continue;
    scanned.add(reference);
    let absolute: string;
    try { absolute = inside(root, reference); } catch { continue; }
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
    const text = executableText(fs.readFileSync(absolute, 'utf8'));
    const discovered = directAssets(text);
    for (const match of text.matchAll(LOCAL_ASSET)) {
      const base = match[1] === 'script_dir' ? path.posix.dirname(reference) : '.ci/runtime';
      const normalized = normalizeAsset(path.posix.join(base, match[2]));
      if (normalized) discovered.add(normalized);
    }
    for (const match of text.matchAll(POWERSHELL_LOCAL_ASSET)) {
      const normalized = normalizeAsset(path.posix.join(path.posix.dirname(reference), match[1]));
      if (normalized) discovered.add(normalized);
    }
    for (const match of text.matchAll(RELATIVE_IMPORT)) {
      const normalized = normalizeAsset(path.posix.join(path.posix.dirname(reference), match[1]));
      if (normalized) discovered.add(normalized);
    }
    if (reference.endsWith('.py')) {
      for (const match of text.matchAll(PYTHON_IMPORT)) {
        const modulePath = (match[1] ?? match[2]).split('.').join('/');
        for (const suffix of ['.py', '/__init__.py']) {
          const normalized = normalizeAsset(
            path.posix.join(path.posix.dirname(reference), `${modulePath}${suffix}`),
          );
          if (!normalized) continue;
          try {
            const absolute = inside(root, normalized);
            if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) discovered.add(normalized);
          } catch {
            continue;
          }
        }
      }
    }
    for (const item of discovered) {
      if (excludedReferences.has(item) || result.has(item)) continue;
      result.add(item);
      queue.push(item);
    }
  }
  return result;
};

const staticallyDisabledStep = (step: ValueMap, workflowEnv: ValueMap): boolean => {
  const condition = step.if;
  if (typeof condition !== 'string') return false;
  const match = condition.match(
    /^\s*(?:\$\{\{\s*)?env\.([A-Z][A-Z0-9_]*)\s*(==|!=)\s*'([^']+)'(?:\s*\}\})?\s*$/,
  );
  if (!match) return false;
  const actual = workflowEnv[match[1]];
  if (typeof actual !== 'string') return false;
  return match[2] === '==' ? actual !== match[3] : actual === match[3];
};

export const findWorkflowAssetReferences = (
  root: string,
  workflowText: string,
  excludedReferences: ReadonlySet<string> = new Set(),
): string[] => {
  const parsed = map(parseYaml(workflowText, 'workflow'));
  const workflowEnv = map(parsed.env);
  const runs: string[] = [];
  if (typeof parsed.run === 'string') runs.push(parsed.run);
  for (const job of Object.values(map(parsed.jobs)).map(map)) {
    for (const step of Array.isArray(job.steps) ? job.steps.map(map) : []) {
      if (!staticallyDisabledStep(step, workflowEnv) && typeof step.run === 'string') {
        runs.push(step.run);
      }
    }
  }
  const directReferences = directAssets(runs.join('\n'));
  for (const excluded of excludedReferences) directReferences.delete(excluded);
  return [...indirectAssets(root, directReferences, excludedReferences)].sort();
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

const filesUnder = (root: string, directory: string, suffixes: string[]): string[] => {
  const absoluteRoot = path.join(root, directory);
  if (!fs.existsSync(absoluteRoot)) return [];
  const result: string[] = [];
  const visit = (absolute: string): void => {
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const entryPath = path.join(absolute, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile() && suffixes.some((suffix) => entry.name.endsWith(suffix))) {
        result.push(path.relative(root, entryPath).split(path.sep).join('/'));
      }
    }
  };
  visit(absoluteRoot);
  return result.sort();
};

const inventoryUnder = (root: string, directory: string): string[] => {
  const absoluteRoot = path.join(root, directory);
  if (!fs.existsSync(absoluteRoot)) return [];
  const result: string[] = [];
  const visit = (absolute: string): void => {
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const entryPath = path.join(absolute, entry.name);
      if (entry.isDirectory() && entry.name === 'node_modules') {
        result.push(path.relative(root, entryPath).split(path.sep).join('/'));
      } else if (entry.isDirectory()) visit(entryPath);
      else result.push(path.relative(root, entryPath).split(path.sep).join('/'));
    }
  };
  visit(absoluteRoot);
  return result.sort();
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
        .some((asset) => asset.destination === workflowPath));
    const excludedReferences = preset
      ? inactiveConditionalEntrypoints(root, registry, preset)
      : new Set<string>();
    const workflowReachable = new Set(findWorkflowAssetReferences(root, fs.readFileSync(
      path.join(root, workflowPath), 'utf8',
    ), excludedReferences));
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
  validateProviderActionPinCompanion(root, parsed, registry, report);
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

const validateNoProjectRuntime = (root: string, report: Report): void => {
  const runtimePath = path.join(root, '.ci/runtime');
  if (!fs.existsSync(runtimePath)) return;
  add(report.mismatches, {
    path: '.ci/runtime',
    message: 'project-local CI runtime is obsolete; prepare dependencies in isolated tool state and remove this directory',
    settingLocation: '.ci/runtime',
  });
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

const descriptorValues = (workflow: unknown): string[] => {
  const result: string[] = [];
  walk(workflow, (key, value) => {
    if (key === 'CI_ADAPTER_DESCRIPTOR' && typeof value === 'string') {
      result.push(value.replace(/^\.ci-base\//, ''));
    }
  });
  return result;
};
const validateDescriptor = (
  root: string,
  descriptorPath: string,
  report: Report,
  workflowEnv: ValueMap,
  providerId: string,
): Set<string> => {
  const destinations = new Set<string>();
  let absolute: string;
  try { absolute = inside(root, descriptorPath); } catch (error) {
    add(report.mismatches, {
      path: descriptorPath,
      message: error instanceof Error ? error.message : 'invalid descriptor path',
      settingLocation: descriptorPath,
    });
    return destinations;
  }
  if (!fs.existsSync(absolute)) {
    add(report.missingSettings, {
      path: descriptorPath,
      message: 'quality adapter descriptor is missing',
      settingLocation: descriptorPath,
    });
    return destinations;
  }
  if (!realPathIsInside(root, absolute)) {
    add(report.mismatches, {
      path: descriptorPath,
      message: 'quality adapter descriptor resolves outside the project root',
      settingLocation: descriptorPath,
    });
    return destinations;
  }
  const descriptor = map(parseYaml(fs.readFileSync(absolute, 'utf8'), descriptorPath, report));
  const exact: Array<[string, unknown, unknown]> = [
    ['schemaVersion', descriptor.schemaVersion, '1'],
    ['kind', descriptor.kind, 'ci-adapter-bundle'],
    ['contract', descriptor.contract, 'quality-scripts'],
    ['executionBoundary', descriptor.executionBoundary, 'read-only'],
    ['sourceCheckout', descriptor.sourceCheckout, 'fixed-source'],
    ['copyable', descriptor.copyable, true],
  ];
  for (const [key, actual, expected] of exact) {
    if (actual !== expected) add(report.mismatches, {
      path: `${descriptorPath}:${key}`,
      message: `${key} must be ${String(expected)}`,
      settingLocation: descriptorPath,
    });
  }
  for (const key of ['id', 'owner', 'provider']) {
    if (typeof descriptor[key] !== 'string' || descriptor[key] === '') add(report.missingSettings, {
      path: `${descriptorPath}:${key}`,
      message: `${key} is missing`,
      settingLocation: descriptorPath,
    });
  }
  if (strings(descriptor.languageProfiles).length === 0) add(report.missingSettings, {
    path: `${descriptorPath}:languageProfiles`,
    message: 'languageProfiles is missing',
    settingLocation: descriptorPath,
  });
  const selectedProfile = workflowEnv.CI_LANGUAGE_PROFILE;
  if (typeof selectedProfile !== 'string'
    || !strings(descriptor.languageProfiles).includes(selectedProfile)) add(report.mismatches, {
    path: `${descriptorPath}:languageProfiles`,
    message: 'quality adapter descriptor does not support the selected language profile',
    settingLocation: descriptorPath,
  });
  if (descriptor.provider !== 'provider-neutral' && descriptor.provider !== providerId) {
    add(report.mismatches, {
      path: `${descriptorPath}:provider`,
      message: 'quality adapter descriptor does not support the selected CI provider',
      settingLocation: descriptorPath,
    });
  }
  const assets = Array.isArray(descriptor.assets) ? descriptor.assets : [];
  assets.forEach((value, index) => {
    const asset = map(value);
    if ('source' in asset) add(report.mismatches, {
      path: `${descriptorPath}:assets[${index}].source`,
      message: 'copied descriptor must not reference a source skill tree',
      settingLocation: descriptorPath,
    });
    const destination = typeof asset.destination === 'string'
      ? path.posix.normalize(asset.destination)
      : '';
    if (!destination.startsWith('.ci/') || destination !== asset.destination) {
      add(report.mismatches, {
        path: `${descriptorPath}:assets[${index}].destination`,
        message: 'asset destination must be project-local under .ci',
        settingLocation: descriptorPath,
      });
      return;
    }
    destinations.add(destination);
    const absoluteDestination = inside(root, destination);
    if (!fs.existsSync(absoluteDestination)) add(report.missingSettings, {
      path: destination,
      message: 'adapter asset is missing',
      settingLocation: descriptorPath,
    });
    else if (!realPathIsInside(root, absoluteDestination)) add(report.mismatches, {
      path: destination,
      message: 'adapter asset resolves outside the project root',
      settingLocation: descriptorPath,
    });
  });
  const projectSettings = map(descriptor.projectSettings);
  if (!Array.isArray(projectSettings.requiredFiles) || !Array.isArray(projectSettings.requiredScripts)) {
    add(report.missingSettings, {
      path: `${descriptorPath}:projectSettings`,
      message: 'projectSettings must declare requiredFiles and requiredScripts',
      settingLocation: descriptorPath,
    });
  }
  for (const name of strings(projectSettings.requiredEnvironmentPaths)) {
    const value = workflowEnv[name];
    if (!/^CI_[A-Z0-9_]+$/.test(name) || typeof value !== 'string'
      || value === '' || path.isAbsolute(value)) {
      add(report.mismatches, {
        path: `${descriptorPath}:projectSettings.requiredEnvironmentPaths.${name}`,
        message: 'required environment path must resolve from a valid workflow setting',
        settingLocation: descriptorPath,
      });
      continue;
    }
    try {
      const absoluteFile = inside(root, value);
      if (!fs.existsSync(absoluteFile) || !fs.statSync(absoluteFile).isFile()) add(report.missingSettings, {
        path: value,
        message: 'required environment path is missing',
        settingLocation: descriptorPath,
      });
      else if (!realPathIsInside(root, absoluteFile)) add(report.mismatches, {
        path: value,
        message: 'required environment path resolves outside the project root',
        settingLocation: descriptorPath,
      });
    } catch (error) {
      add(report.mismatches, {
        path: value,
        message: error instanceof Error ? error.message : 'invalid required environment path',
        settingLocation: descriptorPath,
      });
    }
  }
  for (const file of strings(projectSettings.requiredFiles)) {
    try {
      const absoluteFile = inside(root, file);
      if (!fs.existsSync(absoluteFile)) add(report.missingSettings, {
        path: file,
        message: 'required project file is missing',
        settingLocation: descriptorPath,
      });
      else if (!realPathIsInside(root, absoluteFile)) add(report.mismatches, {
        path: file,
        message: 'required project file resolves outside the project root',
        settingLocation: descriptorPath,
      });
    } catch (error) {
      add(report.mismatches, {
        path: file,
        message: error instanceof Error ? error.message : 'invalid project file path',
        settingLocation: descriptorPath,
      });
    }
  }
  const packagePath = path.join(root, 'package.json');
  let projectScripts: ValueMap = {};
  if (fs.existsSync(packagePath)) {
    try {
      projectScripts = map(map(JSON.parse(fs.readFileSync(packagePath, 'utf8'))).scripts);
    } catch {
      add(report.mismatches, {
        path: 'package.json',
        message: 'invalid project package.json',
        settingLocation: descriptorPath,
      });
    }
  }
  const checkScript = (script: string, visiting = new Set<string>()): void => {
    const command = projectScripts[script];
    if (typeof command !== 'string') {
      add(report.missingSettings, {
        path: `package.json:scripts.${script}`,
        message: 'required project script is missing',
        settingLocation: descriptorPath,
      });
      return;
    }
    if (command.trim() === '') add(report.mismatches, {
      path: `package.json:scripts.${script}`,
      message: 'required project script must not be empty',
      settingLocation: descriptorPath,
    });
    if (/(?:^|[\s'"])(?:\.\/)?skills\//.test(command)) add(report.mismatches, {
      path: `package.json:scripts.${script}`,
      message: 'required project script references the source skills tree',
      settingLocation: descriptorPath,
    });
    if (visiting.has(script)) {
      add(report.mismatches, {
        path: `package.json:scripts.${script}`,
        message: 'project script delegation contains a cycle',
        settingLocation: descriptorPath,
      });
      return;
    }
    visiting.add(script);
    for (const match of command.matchAll(/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([A-Za-z0-9:_-]+)/g)) {
      if (match[1] in projectScripts) checkScript(match[1], visiting);
    }
    visiting.delete(script);
  };
  for (const script of strings(projectSettings.requiredScripts)) checkScript(script);
  const toolchain = map(descriptor.toolchain);
  const verify = map(toolchain.verify);
  if (toolchain.versionEnv !== 'CI_TOOLCHAIN_VERSION' || typeof verify.command !== 'string') {
    add(report.mismatches, {
      path: `${descriptorPath}:toolchain`,
      message: 'toolchain verification must bind CI_TOOLCHAIN_VERSION',
      settingLocation: descriptorPath,
    });
  }
  if (!Array.isArray(descriptor.preparation) || descriptor.preparation.length === 0) {
    add(report.missingSettings, {
      path: `${descriptorPath}:preparation`,
      message: 'dependency preparation is missing',
      settingLocation: descriptorPath,
    });
  }
  if (!Array.isArray(descriptor.commands) || descriptor.commands.length === 0) {
    add(report.missingSettings, {
      path: `${descriptorPath}:commands`,
      message: 'quality commands are missing',
      settingLocation: descriptorPath,
    });
  }
  return destinations;
};

const workflowCallRequired = (workflow: ValueMap): { inputs: string[]; secrets: string[] } => {
  const call = map(on(workflow).workflow_call);
  const required = (value: unknown): string[] => Object.entries(map(value))
    .filter(([, config]) => map(config).required === true)
    .map(([name]) => name);
  return { inputs: required(call.inputs), secrets: required(call.secrets) };
};
const permissionRank = (value: unknown): number => value === 'write' ? 2 : value === 'read' ? 1 : 0;
const effectivePermissions = (workflow: ValueMap, job: ValueMap): ValueMap =>
  Object.prototype.hasOwnProperty.call(job, 'permissions')
    ? map(job.permissions)
    : map(workflow.permissions);
const validateCaller = (
  callerPath: string,
  caller: ValueMap,
  workflows: Map<string, ValueMap>,
  report: Report,
): void => {
  for (const [jobName, jobValue] of Object.entries(map(caller.jobs))) {
    const job = map(jobValue);
    if (typeof job.uses !== 'string' || !job.uses.startsWith('./.github/workflows/')) continue;
    const targetPath = job.uses.slice(2);
    const target = workflows.get(targetPath);
    if (!target) continue;
    const required = workflowCallRequired(target);
    for (const input of required.inputs) {
      if (!(input in map(job.with))) add(report.missingSettings, {
        path: `${callerPath}:jobs.${jobName}.with.${input}`,
        message: `required reusable workflow input ${input} is missing`,
        settingLocation: callerPath,
      });
    }
    for (const secret of required.secrets) {
      if (!(secret in map(job.secrets))) add(report.missingSettings, {
        path: `${callerPath}:jobs.${jobName}.secrets.${secret}`,
        message: `required reusable workflow secret ${secret} is missing`,
        settingLocation: callerPath,
      });
    }
    const callerPermissions = effectivePermissions(caller, job);
    for (const targetJob of Object.values(map(target.jobs)).map(map)) {
      for (const [permission, level] of Object.entries(effectivePermissions(target, targetJob))) {
        if (permissionRank(callerPermissions[permission]) < permissionRank(level)) add(report.mismatches, {
          path: `${callerPath}:jobs.${jobName}.permissions.${permission}`,
          message: `caller permission is below reusable workflow requirement ${String(level)}`,
          settingLocation: callerPath,
        });
      }
    }
  }
};
const workflowRunText = (workflow: ValueMap): string =>
  Object.values(map(workflow.jobs))
    .flatMap((job) => Array.isArray(map(job).steps) ? map(job).steps as unknown[] : [])
    .map((step) => map(step).run)
    .filter((run): run is string => typeof run === 'string')
    .join('\n');
const workflowActionOperations = (workflow: ValueMap, actionPath: string): string[] =>
  Object.values(map(workflow.jobs))
    .flatMap((job) => Array.isArray(map(job).steps) ? map(job).steps as unknown[] : [])
    .map(map)
    .filter((step) => typeof step.uses === 'string' && step.uses.includes(`/${actionPath}@`))
    .map((step) => map(step.with).operation)
    .filter((operation): operation is string => typeof operation === 'string');
const validatePublicationConcurrency = (
  workflows: Map<string, ValueMap>,
  report: Report,
): void => {
  for (const publicationPath of [
    '.github/workflows/release-publication.yml',
    '.github/workflows/package-publication.yml',
  ]) {
    const workflow = workflows.get(publicationPath);
    if (!workflow) continue;
    const concurrency = map(workflow.concurrency);
    if (concurrency['cancel-in-progress'] !== false) add(report.mismatches, {
      path: `${publicationPath}:concurrency.cancel-in-progress`,
      message: 'publication must not cancel a running run',
      settingLocation: publicationPath,
    });
    if (concurrency.queue !== 'max') add(report.mismatches, {
      path: `${publicationPath}:concurrency.queue`,
      message: 'publication must preserve pending runs within the provider queue limit',
      settingLocation: publicationPath,
    });
    const group = String(concurrency.group ?? '');
    const target = publicationPath.endsWith('package-publication.yml');
    const requiredGroupTokens = target
      ? ['github.workflow', 'github.repository', 'inputs.target_identity']
      : ['github.workflow', 'github.repository'];
    const forbiddenGroupTokens = ['github.run_id', 'github.sha'];
    if (requiredGroupTokens.some((token) => !group.includes(token))
      || forbiddenGroupTokens.some((token) => group.includes(token))) add(report.mismatches, {
      path: `${publicationPath}:concurrency.group`,
      message: 'publication concurrency group must bind the logical target without run identity',
      settingLocation: publicationPath,
    });
  }
};
const validatePackagePublicationFlow = (
  workflows: Map<string, ValueMap>,
  report: Report,
): void => {
  const requestPath = '.github/workflows/package-publication-request.yml';
  const callerPath = '.github/workflows/package-publication-caller.yml';
  const caller = workflows.get(callerPath);
  if (!workflows.get(requestPath) || !caller) return;
  const triggerWorkflows = strings(map(on(caller).workflow_run).workflows);
  if (triggerWorkflows.length !== 1 || triggerWorkflows[0] !== 'package-publication-request') add(report.mismatches, {
    path: `${callerPath}:on.workflow_run.workflows`,
    message: 'package publication caller must only accept package-publication-request',
    settingLocation: callerPath,
  });
  const validateJob = map(map(caller.jobs)['validate-request']);
  if (Object.prototype.hasOwnProperty.call(validateJob, 'if')) add(report.mismatches, {
    path: `${callerPath}:jobs.validate-request.if`,
    message: 'trigger conclusion must be validated as a failure, not skipped at job level',
    settingLocation: callerPath,
  });
  const callerRuns = workflowRunText(caller);
  for (const token of [
    'REQUEST_CONCLUSION',
    '.github/workflows/package-publication-request.yml',
    'REQUEST_WORKFLOW_NAME',
    'REQUEST_WORKFLOW_PATH',
    'test "$REQUEST_HEAD_BRANCH" = "$DEFAULT_BRANCH"',
    'REQUEST_HEAD_SHA',
  ]) {
    if (!callerRuns.includes(token)) add(report.missingSettings, {
      path: `${callerPath}:jobs.validate-request.steps`,
      message: `package publication caller provenance check is missing: ${token}`,
      settingLocation: callerPath,
    });
  }
  if (!workflowActionOperations(caller, 'actions/ci-package-publication-request').includes('verify')) add(report.missingSettings, {
    path: `${callerPath}:jobs.validate-request.steps`,
    message: 'package publication caller is missing Action request verification',
    settingLocation: callerPath,
  });
};
const validateReleasePublicationFlow = (
  workflows: Map<string, ValueMap>,
  report: Report,
): void => {
  const requestPath = '.github/workflows/release-publication-request.yml';
  const callerPath = '.github/workflows/release-publication-caller.yml';
  const publicationPath = '.github/workflows/release-publication.yml';
  const request = workflows.get(requestPath);
  const caller = workflows.get(callerPath);
  const publication = workflows.get(publicationPath);
  if (!request || !caller || !publication) return;

  const requestInputs = map(map(on(request).workflow_dispatch).inputs);
  if (Object.prototype.hasOwnProperty.call(requestInputs, 'notes_handoff_run_id')) add(report.mismatches, {
    path: `${requestPath}:on.workflow_dispatch.inputs.notes_handoff_run_id`,
    message: 'release notes handoff run ID must not be supplied by the operator',
    settingLocation: requestPath,
  });
  if (!JSON.stringify(request).includes('"name":"release-notes-handoff"')) add(report.missingSettings, {
    path: `${requestPath}:jobs.request.steps`,
    message: 'release publication request must upload release-notes-handoff',
    settingLocation: requestPath,
  });
  if (!workflowActionOperations(request, 'actions/ci-release-publication-control').includes('create-request')) add(report.missingSettings, {
    path: `${requestPath}:jobs.request.steps`,
    message: 'release publication request is missing Action handoff binding: create-request',
    settingLocation: requestPath,
  });

  const triggerWorkflows = strings(map(on(caller).workflow_run).workflows);
  if (triggerWorkflows.length !== 1 || triggerWorkflows[0] !== 'release-publication-request') add(report.mismatches, {
    path: `${callerPath}:on.workflow_run.workflows`,
    message: 'release publication caller must only accept release-publication-request',
    settingLocation: callerPath,
  });
  const callerJobs = map(caller.jobs);
  const validateJob = map(callerJobs['validate-request']);
  if (Object.prototype.hasOwnProperty.call(validateJob, 'if')) add(report.mismatches, {
    path: `${callerPath}:jobs.validate-request.if`,
    message: 'trigger conclusion must be validated as a failure, not skipped at job level',
    settingLocation: callerPath,
  });
  const callerRuns = workflowRunText(caller);
  for (const token of [
    'REQUEST_CONCLUSION',
    '.github/workflows/release-publication-request.yml',
    'REQUEST_WORKFLOW_PATH',
    'test "$REQUEST_HEAD_BRANCH" = "$DEFAULT_BRANCH"',
    'REQUEST_HEAD_SHA',
  ]) {
    if (!callerRuns.includes(token)) add(report.missingSettings, {
      path: `${callerPath}:jobs.validate-request.steps`,
      message: `release publication caller provenance check is missing: ${token}`,
      settingLocation: callerPath,
    });
  }
  if (!workflowActionOperations(caller, 'actions/ci-release-publication-control').includes('verify-publication-request')) add(report.missingSettings, {
    path: `${callerPath}:jobs.validate-request.steps`,
    message: 'release publication caller is missing Action request verification',
    settingLocation: callerPath,
  });
  const publishWith = map(map(callerJobs.publish).with);
  if (publishWith.publication_request_run_id !== '${{ github.event.workflow_run.id }}') add(report.mismatches, {
    path: `${callerPath}:jobs.publish.with.publication_request_run_id`,
    message: 'publication request run ID must come from the triggering workflow_run',
    settingLocation: callerPath,
  });
  const supplementalAssetEnabled = publishWith.supplemental_release_asset_enabled;
  const supplementalAssetOwnerContract = publishWith.supplemental_release_asset_owner_contract;
  const ownerContractPath = `${callerPath}:jobs.publish.with.supplemental_release_asset_owner_contract`;
  if (supplementalAssetEnabled === true) {
    if (typeof supplementalAssetOwnerContract !== 'string'
      || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$/.test(
        supplementalAssetOwnerContract,
      )) {
      add(report.mismatches, {
        path: ownerContractPath,
        message: 'enabled supplemental asset requires one static dot-separated owner contract ID',
        settingLocation: callerPath,
      });
    }
  } else if (supplementalAssetEnabled === false && supplementalAssetOwnerContract !== '__unset__') add(report.mismatches, {
    path: ownerContractPath,
    message: 'disabled supplemental asset must use the __unset__ owner contract sentinel',
    settingLocation: callerPath,
  });
  const summary = map(callerJobs.summary);
  if (summary.if !== 'always()' || !Array.isArray(summary.needs)) add(report.missingSettings, {
    path: `${callerPath}:jobs.summary`,
    message: 'caller must always report validation and publication results',
    settingLocation: callerPath,
  });

  const requiredInputs = workflowCallRequired(publication).inputs.sort();
  const expectedInputs = [
    'publication_request_run_id',
    'request_run_id',
    'supplemental_release_asset_enabled',
    'supplemental_release_asset_owner_contract',
  ];
  if (JSON.stringify(requiredInputs) !== JSON.stringify(expectedInputs)) add(report.mismatches, {
    path: `${publicationPath}:on.workflow_call.inputs`,
    message: 'trusted publication requires request run IDs and the supplemental asset selection',
    settingLocation: publicationPath,
  });
  const publicationRuns = workflowRunText(publication);
  if (!JSON.stringify(publication).includes('"name":"release-notes-handoff"')) add(report.missingSettings, {
    path: `${publicationPath}:jobs.authority.steps`,
    message: 'trusted publication must download release-notes-handoff',
    settingLocation: publicationPath,
  });
  for (const token of [
    'run-metadata/publication-request.json',
    'authority/publication-request.json',
  ]) {
    if (!publicationRuns.includes(token)) add(report.missingSettings, {
      path: `${publicationPath}:jobs.authority.steps`,
      message: `trusted publication provenance check is missing: ${token}`,
      settingLocation: publicationPath,
    });
  }
  const publicationControlOperations = workflowActionOperations(publication, 'actions/ci-release-publication-control');
  for (const operation of ['verify-provenance', 'verify-approval']) {
    if (!publicationControlOperations.includes(operation)) add(report.missingSettings, {
      path: `${publicationPath}:jobs`,
      message: `trusted publication is missing Action control operation: ${operation}`,
      settingLocation: publicationPath,
    });
  }
  const publicationJobs = map(publication.jobs);
  const authorityJob = map(publicationJobs.authority);
  const qualityJob = map(publicationJobs.quality);
  const buildJob = map(publicationJobs.build);
  const supplementalAssetJob = map(publicationJobs['supplemental-asset']);
  const assembleJob = map(publicationJobs.assemble);
  const summaryJob = map(publicationJobs.summary);
  const authoritySteps = Array.isArray(authorityJob.steps) ? authorityJob.steps.map(map) : [];
  const configSnapshotStep = authoritySteps.find((step) => step.id === 'config');
  const sourcesJson = map(configSnapshotStep?.with)['sources-json'];
  let snapshotSources: ValueMap = {};
  let workflowSnapshot: ValueMap = {};
  if (typeof sourcesJson === 'string') {
    try {
      snapshotSources = map(JSON.parse(sourcesJson));
      workflowSnapshot = map(snapshotSources.workflow);
    } catch {
      workflowSnapshot = {};
    }
  }
  const publicationEnv = map(publication.env);
  for (const [source, values] of Object.entries(snapshotSources)) {
    for (const [key, value] of Object.entries(map(values))) {
      let resolved = value;
      let path = `${publicationPath}:jobs.authority.steps.config.with.sources-json.${source}.${key}`;
      let settingLocation = publicationPath;
      const envMatch = typeof value === 'string'
        ? /^\$\{\{\s*env\.([A-Za-z][A-Za-z0-9_]*)\s*\}\}$/.exec(value)
        : undefined;
      const inputMatch = typeof value === 'string'
        ? /^\$\{\{\s*inputs\.([A-Za-z][A-Za-z0-9_]*)\s*\}\}$/.exec(value)
        : undefined;
      if (envMatch) {
        resolved = publicationEnv[envMatch[1]];
        path = `${publicationPath}:env.${envMatch[1]}`;
      } else if (inputMatch) {
        resolved = publishWith[inputMatch[1]];
        path = `${callerPath}:jobs.publish.with.${inputMatch[1]}`;
        settingLocation = callerPath;
      }
      const runtimeValue = typeof resolved === 'string'
        ? resolved
        : typeof resolved === 'boolean' || typeof resolved === 'number' ? String(resolved) : undefined;
      if (runtimeValue !== undefined
        && runtimeValue.length > 0
        && !/[\0\r\n]/.test(runtimeValue)
        && !runtimeValue.includes('${{')) continue;
      add(report.mismatches, {
        path,
        message: 'ci-config-snapshot values must resolve from static non-empty strings without NUL or line breaks',
        settingLocation,
      });
    }
  }
  const expectedSupplementalAssetSnapshot: Record<string, string> = {
    CI_SUPPLEMENTAL_RELEASE_ASSET_ENABLED: '${{ inputs.supplemental_release_asset_enabled }}',
    CI_SUPPLEMENTAL_RELEASE_ASSET_CONTRACT:
      'ci.release-asset-publication-contract#supplementalAsset',
    CI_SUPPLEMENTAL_RELEASE_ASSET_OWNER_CONTRACT:
      '${{ inputs.supplemental_release_asset_owner_contract }}',
    CI_SUPPLEMENTAL_RELEASE_ASSET_ADAPTER: '.ci/scripts/ci-release-supplemental-asset.sh',
  };
  for (const [key, value] of Object.entries(expectedSupplementalAssetSnapshot)) {
    if (workflowSnapshot[key] !== value) add(report.mismatches, {
      path: `${publicationPath}:jobs.authority.steps.config.with.sources-json.workflow.${key}`,
      message: `supplemental asset selection must be recorded in the authority snapshot: ${key}`,
      settingLocation: publicationPath,
    });
  }
  if (Object.keys(qualityJob).length === 0) add(report.missingSettings, {
    path: `${publicationPath}:jobs.quality`,
    message: 'release publication quality job is missing',
    settingLocation: publicationPath,
  });
  if (!JSON.stringify(qualityJob).includes('/actions/ci-quality-adapter@')) add(report.missingSettings, {
    path: `${publicationPath}:jobs.quality.steps`,
    message: 'release publication quality adapter invocation is missing',
    settingLocation: publicationPath,
  });
  if (!strings(buildJob.needs).includes('quality')) add(report.mismatches, {
    path: `${publicationPath}:jobs.build.needs`,
    message: 'release build must require successful quality completion',
    settingLocation: publicationPath,
  });
  if (supplementalAssetJob.if !== 'inputs.supplemental_release_asset_enabled'
    || JSON.stringify(strings(supplementalAssetJob.needs).sort())
      !== JSON.stringify(['authority', 'build', 'quality', 'source-gate'])) add(report.mismatches, {
    path: `${publicationPath}:jobs.supplemental-asset`,
    message: 'supplemental asset job must use the static input after trusted prerequisites',
    settingLocation: publicationPath,
  });
  const buildSteps = Array.isArray(buildJob.steps) ? buildJob.steps.map(map) : [];
  const supplementalPlatformVerification = buildSteps.find(
    (step) => step.name === 'Build and verify supplemental Release asset platform',
  );
  const supplementalPlatformCommand = supplementalAdapterCommand('buildPlatform', {
    'authority-context-path': 'authority/authority.json',
    'config-snapshot-path': 'authority/config-snapshot.json',
    'standard-platform-build-directory': 'build/${{ matrix.id }}',
    'supplemental-platform-output-directory': 'supplemental-build/${{ matrix.id }}',
  }, report);
  if (supplementalPlatformVerification?.if !== 'inputs.supplemental_release_asset_enabled'
    || supplementalPlatformVerification?.shell !== 'bash'
    || supplementalPlatformVerification?.run !== supplementalPlatformCommand) add(report.mismatches, {
    path: `${publicationPath}:jobs.build.steps.Build and verify supplemental Release asset platform`,
    message: 'supplemental asset platform build must use the current adapter interface',
    settingLocation: publicationPath,
  });
  const supplementalPlatformUpload = buildSteps.find(
    (step) => typeof step.uses === 'string'
      && step.uses.startsWith('actions/upload-artifact@')
      && map(step.with).name === 'supplemental-build-${{ matrix.id }}',
  );
  const supplementalPlatformUploadWith = map(supplementalPlatformUpload?.with);
  if (supplementalPlatformUpload?.if !== 'inputs.supplemental_release_asset_enabled'
    || supplementalPlatformUploadWith.path !== 'supplemental-build/${{ matrix.id }}'
    || supplementalPlatformUploadWith['if-no-files-found'] !== 'error') add(report.mismatches, {
    path: `${publicationPath}:jobs.build.steps.supplemental-platform-upload`,
    message: 'supplemental platform output must use a dedicated artifact handoff',
    settingLocation: publicationPath,
  });
  const supplementalAssetSteps = Array.isArray(supplementalAssetJob.steps)
    ? supplementalAssetJob.steps.map(map) : [];
  const supplementalBuildDownload = supplementalAssetSteps.find(
    (step) => map(step.with).pattern === 'release-build-*',
  );
  if (map(supplementalBuildDownload?.with).path !== 'build') add(report.mismatches, {
    path: `${publicationPath}:jobs.supplemental-asset.steps.release-build-download`,
    message: 'supplemental asset assembly must download all platform builds',
    settingLocation: publicationPath,
  });
  const supplementalPlatformDownload = supplementalAssetSteps.find(
    (step) => typeof step.uses === 'string'
      && step.uses.startsWith('actions/download-artifact@')
      && map(step.with).pattern === 'supplemental-build-*',
  );
  if (map(supplementalPlatformDownload?.with).path !== 'supplemental-build') add(report.mismatches, {
    path: `${publicationPath}:jobs.supplemental-asset.steps.supplemental-build-download`,
    message: 'supplemental asset assembly must download the supplemental platform handoff',
    settingLocation: publicationPath,
  });
  const supplementalAssembly = supplementalAssetSteps.find(
    (step) => step.name === 'Build and verify supplemental Release asset',
  );
  const supplementalAssemblyCommand = supplementalAdapterCommand('assemble', {
    'authority-context-path': 'authority/authority.json',
    'config-snapshot-path': 'authority/config-snapshot.json',
    'standard-platform-build-root': 'build',
    'supplemental-platform-build-root': 'supplemental-build',
    'output-directory': 'supplemental-asset',
  }, report);
  if (supplementalAssembly?.shell !== 'bash'
    || supplementalAssembly?.run !== supplementalAssemblyCommand) add(report.mismatches, {
    path: `${publicationPath}:jobs.supplemental-asset.steps.Build and verify supplemental Release asset`,
    message: 'supplemental asset assembly must use the current adapter interface',
    settingLocation: publicationPath,
  });
  const assembleCondition = typeof assembleJob.if === 'string' ? assembleJob.if : '';
  for (const token of [
    '!cancelled()',
    "needs.authority.result == 'success'",
    "needs.build.result == 'success'",
    "needs.supplemental-asset.result == 'success'",
    "needs.supplemental-asset.result == 'skipped'",
  ]) {
    if (!assembleCondition.includes(token)) add(report.mismatches, {
      path: `${publicationPath}:jobs.assemble.if`,
      message: `release assembly condition is missing: ${token}`,
      settingLocation: publicationPath,
    });
  }
  if (!strings(assembleJob.needs).includes('supplemental-asset')) add(report.mismatches, {
    path: `${publicationPath}:jobs.assemble.needs`,
    message: 'release assembly must wait for the supplemental asset selection result',
    settingLocation: publicationPath,
  });
  if (!strings(summaryJob.needs).includes('quality')
    || !strings(summaryJob.needs).includes('supplemental-asset')
    || summaryJob.if !== 'always()') add(report.mismatches, {
    path: `${publicationPath}:jobs.summary`,
    message: 'release summary must always collect quality and supplemental asset results',
    settingLocation: publicationPath,
  });
};
const validatePublicationRequest = (
  displayPath: string,
  workflow: ValueMap,
  requiredInputs: string[],
  report: Report,
): void => {
  const releaseRequest = displayPath.endsWith('release-publication-request.yml');
  validateDispatchInputs(
    displayPath,
    workflow,
    requiredInputs,
    report,
  );
  if (!releaseRequest && uses(workflow).some((value) => value.startsWith('actions/checkout@'))) add(report.mismatches, {
    path: `${displayPath}:uses.actions/checkout`,
    message: 'request workflow must not check out source',
    settingLocation: displayPath,
  });
  if (releaseRequest) {
    for (const [permission, level] of Object.entries(map(workflow.permissions))) {
      if (level === 'write') add(report.mismatches, {
        path: `${displayPath}:permissions.${permission}`,
        message: 'request workflow must not declare write permission',
        settingLocation: displayPath,
      });
    }
  }
  for (const [jobName, jobValue] of Object.entries(map(workflow.jobs))) {
    const job = map(jobValue);
    const permissions = effectivePermissions(workflow, job);
    const entries = releaseRequest
      ? Object.entries(map(job.permissions))
      : ['contents', 'packages'].map((permission) => [permission, permissions[permission]]);
    for (const [permission, level] of entries) {
      if (level === 'write') add(report.mismatches, {
        path: `${displayPath}:jobs.${jobName}.permissions.${permission}`,
        message: releaseRequest
          ? 'request workflow must not have write permission'
          : 'request workflow must not have publication permission',
        settingLocation: displayPath,
      });
    }
  }
};
const validateDispatchInputs = (
  displayPath: string,
  workflow: ValueMap,
  names: string[],
  report: Report,
): void => {
  const inputs = map(map(on(workflow).workflow_dispatch).inputs);
  for (const name of names) {
    if (map(inputs[name]).required !== true) add(report.missingSettings, {
      path: `${displayPath}:on.workflow_dispatch.inputs.${name}`,
      message: `required request input ${name} is missing`,
      settingLocation: displayPath,
    });
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

const validateQualityPreset = (
  context: InspectionContext,
  preset: Preset,
): void => {
  const { root } = context;
  if (!preset.qualityAdapter) return;
  const primary = preset.workflowAssets.find((asset) => asset.id === preset.id)
    ?? preset.workflowAssets[0];
  for (const installed of installedPresetWorkflows(root, preset)) {
    const declared = descriptorValues(installed.workflow).length > 0
      || map(installed.workflow.env).CI_ADAPTER_DESCRIPTOR !== undefined;
    if (!declared && installed.path !== primary?.destination) continue;
    validateQualityWorkflow(context, installed.path, installed.workflow);
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
  const unique = [...new Set(values)];
  if (values.length === 0) {
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
  const workflowPath = preset.workflowAssets.find((asset) => asset.id === preset.id)?.destination;
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
  let manifestIds = new Set<string>();
  try {
    validatePlatformManifestContent(manifestText);
    const manifest = map(parseYaml(manifestText, manifestPath, report));
    manifestIds = new Set(
      (Array.isArray(manifest.platforms) ? manifest.platforms : [])
        .filter((value): value is ValueMap => isMap(value))
        .map((value) => String(value.id)),
    );
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
  const selection = map(parseYaml(
    fs.readFileSync(selectionAbsolute, 'utf8'),
    selectionPath,
    report,
  ));
  if (Object.keys(selection).sort().join(',') !== 'platforms'
    || !Array.isArray(selection.platforms) || selection.platforms.length === 0) {
    add(report.mismatches, {
      path: selectionPath,
      message: 'quality platform selection must contain only a non-empty platforms list',
      settingLocation: selectionPath,
    });
    return;
  }
  const seen = new Set<string>();
  for (const [index, value] of selection.platforms.entries()) {
    const entry = map(value);
    if (Object.keys(entry).sort().join(',') !== 'id' || typeof entry.id !== 'string') {
      add(report.mismatches, {
        path: `${selectionPath}:platforms[${index}]`,
        message: 'platform selection entry must contain only an id',
        settingLocation: selectionPath,
      });
      continue;
    }
    if (seen.has(entry.id)) add(report.mismatches, {
      path: `${selectionPath}:platforms[${index}].id`,
      message: 'platform selection id is duplicated',
      settingLocation: selectionPath,
    });
    seen.add(entry.id);
    if (!manifestIds.has(entry.id)) add(report.mismatches, {
      path: `${selectionPath}:platforms[${index}].id`,
      message: 'platform selection id is not declared in the platform manifest',
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
  const workflowPath = preset.workflowAssets.find((asset) => asset.id === preset.id)?.destination;
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
    const expectedUse = `${registry.actionRepository}/${target.actionPath}@${registry.actionExactRef}`;
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
    if (selectedDescriptors.length !== 1 || selectedDescriptors[0] !== bundle.targetDescriptor) add(report.mismatches, {
      path: `${workflowPath}:env.CI_ADAPTER_DESCRIPTOR`,
      message: 'quality adapter descriptor does not match the selected standard implementation dependency',
      settingLocation: workflowPath,
    });
    const dependencyAssets = adapterBundleAssets(bundle, registry.skillCollectionRoot, report);
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
    const publicationWorkflow = preset.workflowAssets.find((asset) => asset.id === preset.id);
    const publicationText = publicationWorkflow
      && fs.existsSync(path.join(root, publicationWorkflow.destination))
      ? fs.readFileSync(path.join(root, publicationWorkflow.destination), 'utf8')
      : '';
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

const validateCiPresetInternal = (options: {
  repoRoot: string;
  skillCollectionRoot?: string;
  presets?: string[];
}, requireAssetLock: boolean): Report => {
  const report: Report = {
    schemaVersion: '1',
    phase: 'provider-preflight',
    status: 'success',
    inspectedPresets: [],
    excludedPresets: [],
    inspectedWorkflows: [],
    excludedWorkflows: [],
    missingSettings: [],
    mismatches: [],
    evidence: [],
    semanticReviewRequired: false,
    semanticCandidates: [],
  };
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

  report.evidence.unshift(...report.inspectedWorkflows.map((workflow) => `${workflow}: inspected`));
  if (report.missingSettings.length > 0 || report.mismatches.length > 0) report.status = 'failed';
  return report;
};

export const validateCiPreset = (options: {
  repoRoot: string;
  skillCollectionRoot?: string;
  presets?: string[];
}): Report => validateCiPresetInternal(options, true);

export const writeCiAssetLock = (options: {
  repoRoot: string;
  skillCollectionRoot?: string;
  sourceRevision: string;
  generatedAt?: string | Date;
}): AssetLock => {
  const root = path.resolve(options.repoRoot);
  return writeAssetLock({
    sourceRevision: options.sourceRevision,
    generatedAt: options.generatedAt,
    validate: () => validateCiPresetInternal({
      repoRoot: options.repoRoot,
      skillCollectionRoot: options.skillCollectionRoot,
    }, false),
    resolvePlan: () => {
      const registryReport: Report = {
        schemaVersion: '1',
        phase: 'provider-preflight',
        status: 'success',
        inspectedPresets: [],
        excludedPresets: [],
        inspectedWorkflows: [],
        excludedWorkflows: [],
        missingSettings: [],
        mismatches: [],
        evidence: [],
        semanticReviewRequired: false,
        semanticCandidates: [],
      };
      const registry = loadRegistry(registryReport);
      registry.skillCollectionRoot = options.skillCollectionRoot === undefined
        ? undefined
        : path.resolve(options.skillCollectionRoot);
      const selected = selectPresets(root, registry.presets, [], registryReport);
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

const parseArgs = (argv: string[]): {
  repoRoot: string;
  skillCollectionRoot?: string;
  presets: string[];
  output?: string;
} => {
  const result: {
    repoRoot: string;
    skillCollectionRoot?: string;
    presets: string[];
    output?: string;
  } = { repoRoot: '.', presets: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
    if (flag === '--repo-root') result.repoRoot = value;
    else if (flag === '--skill-collection-root') result.skillCollectionRoot = value;
    else if (flag === '--preset') result.presets.push(value);
    else if (flag === '--output') result.output = value;
    else throw new Error(`unknown argument: ${flag}`);
    index += 1;
  }
  return result;
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = validateCiPreset(options);
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (options.output) fs.writeFileSync(options.output, output);
    else process.stdout.write(output);
    process.exitCode = report.status === 'success' ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
