#!/usr/bin/env -S node --import tsx

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const yaml = require('../preset/node_modules/yaml') as { parse(source: string): unknown };
const FULL_SHA = /^[0-9a-f]{40}$/;
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;
const MANIFEST_NAME = 'a3-ci-github-distribution-manifest.json';
const FETCH_CLI_NAME = 'fetch-a3-ci-github.mjs';
const CHECKSUM_NAME = 'SHA256SUMS';

type ValueMap = Record<string, unknown>;
type DistributionAsset = {
  id: string;
  application: string;
  dependencies: string[];
  sourcePaths?: string[];
  sourceTree?: string;
};
type ManifestFile = { sourcePath: string; destination?: string };
type ManifestAsset = DistributionAsset & { files: ManifestFile[] };

const map = (value: unknown): ValueMap => value && typeof value === 'object' && !Array.isArray(value)
  ? value as ValueMap : {};
const strings = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((entry): entry is string => typeof entry === 'string') : [];
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const normalizeRelative = (value: string): string => {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw new Error(`distribution-path-invalid:${value}`);
  }
  return normalized;
};
const gitBytes = (repositoryRoot: string, args: string[]): Buffer => {
  const result = spawnSync('git', args, {
    cwd: repositoryRoot,
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0 || !(result.stdout instanceof Buffer)) {
    const diagnostic = result.stderr instanceof Buffer ? result.stderr.toString('utf8').trim() : '';
    throw new Error(`distribution-release-git-read-failed:${diagnostic}`);
  }
  return result.stdout;
};
const sourceBytes = (repositoryRoot: string, revision: string, relative: string): Buffer => {
  const sourcePath = normalizeRelative(relative);
  return gitBytes(repositoryRoot, ['show', `${revision}:${sourcePath}`]);
};
const readYaml = (repositoryRoot: string, revision: string, relative: string): ValueMap => map(yaml.parse(
  sourceBytes(repositoryRoot, revision, relative).toString('utf8'),
));
const filesUnder = (repositoryRoot: string, revision: string, relativeRoot: string): string[] => {
  const root = normalizeRelative(relativeRoot);
  const records = gitBytes(repositoryRoot, ['ls-tree', '-r', '-z', '--full-tree', revision, '--', root])
    .toString('utf8').split('\0').filter(Boolean);
  return records.map((record) => {
    const [metadata, sourcePath] = record.split('\t');
    const [mode, type] = metadata!.split(' ');
    if (mode === '120000') throw new Error(`distribution-source-symlink:${sourcePath}`);
    if (type !== 'blob' || !sourcePath) throw new Error(`distribution-source-not-regular:${sourcePath ?? root}`);
    return normalizeRelative(sourcePath);
  }).sort();
};
const parseArgs = (argv: string[]): { repositoryRoot: string; outputDirectory: string; sourceRevision: string; releaseTag: string } => {
  const result = { repositoryRoot: '.', outputDirectory: '', sourceRevision: '', releaseTag: '' };
  const fields: Record<string, keyof typeof result> = {
    '--repository-root': 'repositoryRoot',
    '--output-directory': 'outputDirectory',
    '--source-revision': 'sourceRevision',
    '--release-tag': 'releaseTag',
  };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]!;
    const value = argv[index + 1];
    const field = fields[flag];
    if (!field || !value || value.startsWith('--')) throw new Error(`distribution-release-argument-invalid:${flag}`);
    result[field] = value;
  }
  if (!result.outputDirectory) throw new Error('distribution-release-output-required');
  if (!FULL_SHA.test(result.sourceRevision)) throw new Error('distribution-release-source-revision-invalid');
  if (!RELEASE_TAG.test(result.releaseTag)) throw new Error('distribution-release-tag-invalid');
  return result;
};

export const prepareDistributionRelease = (options: {
  repositoryRoot: string;
  outputDirectory: string;
  sourceRevision: string;
  releaseTag: string;
}): ValueMap => {
  const repositoryRoot = path.resolve(options.repositoryRoot);
  const outputDirectory = path.resolve(options.outputDirectory);
  if (fs.existsSync(outputDirectory)) throw new Error('distribution-release-output-exists');
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' });
  if (head.status !== 0 || head.stdout.trim() !== options.sourceRevision) {
    throw new Error('distribution-release-source-head-mismatch');
  }
  const version = sourceBytes(repositoryRoot, options.sourceRevision, 'VERSION').toString('utf8').trim();
  if (options.releaseTag !== `v${version}`) throw new Error('distribution-release-version-mismatch');
  const distributionRegistry = readYaml(
    repositoryRoot,
    options.sourceRevision,
    'skills/ci-github/references/ci-distribution-assets.reference.yml',
  );
  const presetRegistry = readYaml(
    repositoryRoot,
    options.sourceRevision,
    'skills/ci-github/references/ci-github-preset-assets.reference.yml',
  );
  const repository = map(distributionRegistry.repository);
  const configuredAssets = Array.isArray(distributionRegistry.assets) ? distributionRegistry.assets.map(map) : [];
  const assets: ManifestAsset[] = configuredAssets.map((candidate) => {
    const sourceTree = typeof candidate.sourceTree === 'string' ? candidate.sourceTree : undefined;
    const sourcePaths = sourceTree
      ? filesUnder(repositoryRoot, options.sourceRevision, sourceTree)
      : strings(candidate.sourcePaths);
    return {
      id: String(candidate.id ?? ''),
      application: String(candidate.application ?? ''),
      dependencies: strings(candidate.dependencies),
      files: sourcePaths.map((sourcePath) => ({ sourcePath: normalizeRelative(sourcePath) })),
      ...(sourceTree ? { sourceTree } : {}),
    };
  });
  const presetDefinitions = Array.isArray(map(presetRegistry.registry).presets)
    ? (map(presetRegistry.registry).presets as unknown[]).map(map) : [];
  const workflowDependencies = map(distributionRegistry.workflowDependencies);
  const workflowIds = new Set<string>();
  for (const preset of presetDefinitions) {
    const workflows = [
      ...(Array.isArray(preset.workflowAssets) ? preset.workflowAssets : []),
      ...(Array.isArray(preset.optionalWorkflowAssets) ? preset.optionalWorkflowAssets : []),
    ].map(map);
    for (const workflow of workflows) {
      const id = `workflow.${String(workflow.id ?? '')}`;
      if (workflowIds.has(id)) continue;
      workflowIds.add(id);
      assets.push({
        id,
        application: 'copy',
        dependencies: strings(workflowDependencies[id]),
        files: [{
          sourcePath: normalizeRelative(String(workflow.source ?? '')),
          destination: normalizeRelative(String(workflow.destination ?? '')),
        }],
      });
    }
  }
  for (const id of Object.keys(workflowDependencies)) {
    if (!workflowIds.has(id)) throw new Error(`distribution-workflow-unknown:${id}`);
  }
  const assetIds = new Set<string>();
  for (const asset of assets) {
    if (!asset.id || assetIds.has(asset.id) || asset.files.length === 0) throw new Error(`distribution-asset-invalid:${asset.id}`);
    assetIds.add(asset.id);
  }
  for (const asset of assets) {
    for (const dependency of asset.dependencies) {
      if (!assetIds.has(dependency)) throw new Error(`distribution-dependency-unknown:${dependency}`);
    }
  }
  const configuredPresets = new Map((Array.isArray(distributionRegistry.presets) ? distributionRegistry.presets : [])
    .map(map).map((preset) => [String(preset.id ?? ''), strings(preset.requiredAssets)]));
  const presets = presetDefinitions.map((preset) => {
    const id = String(preset.id ?? '');
    const workflows = (Array.isArray(preset.workflowAssets) ? preset.workflowAssets : []).map(map);
    const optionalWorkflows = (Array.isArray(preset.optionalWorkflowAssets)
      ? preset.optionalWorkflowAssets : []).map(map);
    const requiredAssets = [
      ...workflows.map((workflow) => `workflow.${String(workflow.id ?? '')}`),
      ...(configuredPresets.get(id) ?? []),
    ];
    const optionalAssets = optionalWorkflows.map((workflow) => `workflow.${String(workflow.id ?? '')}`);
    if ([...requiredAssets, ...optionalAssets].some((assetId) => !assetIds.has(assetId))) {
      throw new Error(`distribution-preset-invalid:${id}`);
    }
    return { id, requiredAssets, optionalAssets };
  });
  const files: Record<string, { sha256: string; size: number }> = {};
  const workflowTemplates = Object.fromEntries(assets.filter((asset) => asset.id.startsWith('workflow.'))
    .map((asset) => [asset.files[0]!.sourcePath, {
      emptyAllowed: strings(map(presetRegistry.conformance).emptyAllowedPlaceholders),
      triggerExtensions: map(map(map(presetRegistry.conformance).workflowTriggerExtensions)[asset.id.slice('workflow.'.length)]),
    }]));
  const workflowReferences: Record<string, string> = {};
  const reusableWorkflows: Record<string, unknown> = {};
  for (const bindingName of ['qualityReusableWorkflow', 'qualityPlatformsReusableWorkflow',
    'packagePreparationReusableWorkflow', 'releasePublicationReusableWorkflow', 'packagePublicationReusableWorkflow']) {
    const binding = map(presetRegistry[bindingName]);
    workflowReferences[String(binding.referencePlaceholder).slice(1, -1)] = options.sourceRevision;
    reusableWorkflows[String(binding.source)] = {
      referencePlaceholder: binding.referencePlaceholder,
      sourceRevision: options.sourceRevision,
    };
  }
  for (const provider of Array.isArray(map(presetRegistry.providerActions).entries)
    ? map(presetRegistry.providerActions).entries as unknown[] : []) {
    const entry = map(provider);
    workflowReferences[String(entry.action)] = String(entry.commitSha);
  }
  for (const asset of assets) {
    for (const file of asset.files) {
      const bytes = sourceBytes(repositoryRoot, options.sourceRevision, file.sourcePath);
      const observed = { sha256: sha256(bytes), size: bytes.length };
      const existing = files[file.sourcePath];
      if (existing && (existing.sha256 !== observed.sha256 || existing.size !== observed.size)) {
        throw new Error(`distribution-source-identity-conflict:${file.sourcePath}`);
      }
      files[file.sourcePath] = observed;
    }
  }
  const manifest = {
    schemaVersion: '2',
    kind: 'a3-ci-github-distribution-manifest',
    version,
    releaseTag: options.releaseTag,
    sourceRevision: options.sourceRevision,
    repository: String(repository.slug ?? ''),
    rawOrigin: String(repository.rawOrigin ?? ''),
    assets: assets.sort((left, right) => left.id.localeCompare(right.id)),
    presets: presets.sort((left, right) => left.id.localeCompare(right.id)),
    files: Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right))),
    workflowTemplates,
    workflowReferences,
    reusableWorkflows,
  };
  fs.mkdirSync(outputDirectory, { recursive: false });
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(outputDirectory, MANIFEST_NAME), manifestBytes, { flag: 'wx' });
  const fetchBytes = sourceBytes(
    repositoryRoot,
    options.sourceRevision,
    'runtime/distribution/fetch-a3-ci-github.mjs',
  );
  fs.writeFileSync(path.join(outputDirectory, FETCH_CLI_NAME), fetchBytes, { flag: 'wx', mode: 0o755 });
  const checksums = [
    `${sha256(manifestBytes)}  ${MANIFEST_NAME}`,
    `${sha256(fetchBytes)}  ${FETCH_CLI_NAME}`,
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(outputDirectory, CHECKSUM_NAME), checksums, { flag: 'wx' });
  return { manifest, outputDirectory, assets: [MANIFEST_NAME, FETCH_CLI_NAME, CHECKSUM_NAME] };
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = prepareDistributionRelease(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
