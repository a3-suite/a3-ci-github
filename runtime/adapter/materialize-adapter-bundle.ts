import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { pathsReferToSameFile } from '../path/same-file-core.mjs';
import { isDirectExecution, resolveOutputPath } from './cli-runtime.ts';

type YamlDocument = { errors: unknown[]; toJS: () => unknown };
type ResourceSource = string | { skill?: string; path: string };
type SourceAsset = {
  id: string;
  entrypoints: string[];
  source?: ResourceSource;
  copyable: boolean;
};
type BundleInventory = {
  id: string;
  source: ResourceSource;
  targetDescriptor: string;
};

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
type AdapterAsset = { id: string; destination: string };
type AdapterCommand = { id?: string; command: string; args: string[] };
type AdapterDescriptor = {
  schemaVersion: string;
  kind: string;
  id: string;
  assets: AdapterAsset[];
  commands: AdapterCommand[];
  preparation: AdapterCommand[];
  toolchain: { versionEnv: string; verify: AdapterCommand };
  projectSettings: { requiredFiles: string[]; requiredScripts: string[] };
};

const require = createRequire(import.meta.url);

const resolveYamlRuntime = (): { parseDocument: (input: string, options?: { prettyErrors?: boolean }) => YamlDocument } => {
  const runtimeRoot = process.env.CI_FIXED_RUNTIME_ROOT;
  if (!runtimeRoot) throw new Error('adapter-materializer-yaml-runtime-root-required');
  const yamlRuntimePath = path.resolve(runtimeRoot, 'node_modules/yaml');
  if (!fs.existsSync(yamlRuntimePath)) throw new Error('adapter-materializer-yaml-runtime-missing');
  return require(yamlRuntimePath) as {
    parseDocument: (input: string, options?: { prettyErrors?: boolean }) => YamlDocument;
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/.test(value)) {
    throw new Error(`adapter-materializer-${field}-invalid`);
  }
  return value;
};

const stringList = (value: unknown, field: string, allowEmpty = false): string[] => {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(`adapter-materializer-${field}-invalid`);
  }
  return value.map((item) => nonEmptyString(item, field));
};

const resourceRelativePath = (source: ResourceSource, field: string): string => {
  if (typeof source === 'string') return nonEmptyString(source, field);
  if (!isRecord(source)) throw new Error(`adapter-materializer-${field}-invalid`);
  return nonEmptyString(source.path, field);
};

const resourceSkill = (source: ResourceSource): string | undefined => {
  if (typeof source === 'string') return undefined;
  const skill = source.skill;
  return typeof skill === 'string' && skill.length > 0 ? skill : undefined;
};

const parseResourceSource = (value: unknown, field: string): ResourceSource => {
  if (typeof value === 'string') return nonEmptyString(value, field);
  if (!isRecord(value)) throw new Error(`adapter-materializer-${field}-invalid`);
  const parsed: { skill?: string; path: string } = {
    path: nonEmptyString(value.path, field),
  };
  if (value.skill !== undefined) parsed.skill = nonEmptyString(value.skill, field);
  return parsed;
};

const resourceDisplay = (source: ResourceSource): string => {
  const skill = resourceSkill(source);
  const relative = resourceRelativePath(source, 'resource-path');
  return skill === undefined ? relative : `${skill}/${relative}`;
};

const resolveResource = (sourceRoot: string, source: ResourceSource): string => {
  const relative = resourceRelativePath(source, 'resource-path');
  const skill = resourceSkill(source);
  if (skill === undefined) return resolveInside(REPOSITORY_ROOT, relative);
  const direct = resolveInside(sourceRoot, skill);
  if (fs.existsSync(path.join(direct, 'SKILL.md'))) return resolveInside(direct, relative);
  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const nested = path.join(sourceRoot, entry.name, skill);
    if (fs.existsSync(path.join(nested, 'SKILL.md'))) return resolveInside(nested, relative);
  }
  throw new Error(`adapter-materializer-skill-not-found:${skill}`);
};

const resolveContainedPath = (absoluteRoot: string, requested: string): string => {
  const candidate = path.resolve(absoluteRoot, requested);
  const relative = path.relative(absoluteRoot, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`adapter-materializer-path-outside-root:${requested}`);
  }
  return candidate;
};

const resolveInside = (root: string, requested: string): string => {
  const absoluteRoot = path.resolve(root);
  const candidate = resolveContainedPath(absoluteRoot, requested);
  const realRoot = fs.realpathSync(absoluteRoot);
  let cursor = absoluteRoot;
  for (const part of path.relative(absoluteRoot, candidate).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
    if (!stat.isSymbolicLink()) continue;
    let realLink: string;
    try {
      realLink = fs.realpathSync(cursor);
    } catch {
      throw new Error(`adapter-materializer-symlink-outside-root:${requested}`);
    }
    const realRelative = path.relative(realRoot, realLink);
    if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
      throw new Error(`adapter-materializer-symlink-outside-root:${requested}`);
    }
  }
  return candidate;
};

const parseYaml = (filePath: string): unknown => {
  const document = resolveYamlRuntime().parseDocument(fs.readFileSync(filePath, 'utf8'), { prettyErrors: false });
  if (document.errors.length > 0) throw new Error(`adapter-materializer-yaml-invalid:${filePath}`);
  return document.toJS();
};

const parseDescriptor = (filePath: string): AdapterDescriptor => {
  const value = parseYaml(filePath);
  if (!isRecord(value) || value.schemaVersion !== '1' || value.kind !== 'ci-adapter-bundle') {
    throw new Error('adapter-materializer-descriptor-invalid');
  }
  if (value.contract !== 'quality-scripts'
    || value.provider !== 'provider-neutral'
    || value.executionBoundary !== 'read-only'
    || value.sourceCheckout !== 'fixed-source'
    || value.copyable !== true) {
    throw new Error('adapter-materializer-descriptor-contract-invalid');
  }
  stringList(value.languageProfiles, 'language-profiles');
  nonEmptyString(value.owner, 'descriptor-owner');
  const assetsValue = value.assets;
  if (!Array.isArray(assetsValue)) throw new Error('adapter-materializer-assets-invalid');
  const assets = assetsValue.map((item) => {
    if (!isRecord(item) || item.source !== undefined) throw new Error('adapter-materializer-source-field-forbidden');
    return {
      id: nonEmptyString(item.id, 'asset-id'),
      destination: nonEmptyString(item.destination, 'asset-destination'),
    };
  });
  const projectSettings = isRecord(value.projectSettings) ? value.projectSettings : undefined;
  if (!projectSettings) throw new Error('adapter-materializer-project-settings-invalid');
  const parseCommands = (items: unknown, field: string): AdapterCommand[] => {
    if (!Array.isArray(items) || items.length === 0) throw new Error(`adapter-materializer-${field}-invalid`);
    return items.map((item) => {
    if (!isRecord(item)) throw new Error('adapter-materializer-command-invalid');
    return {
      ...(item.id === undefined ? {} : { id: nonEmptyString(item.id, 'command-id') }),
      command: nonEmptyString(item.command, 'command'),
      args: item.args === undefined ? [] : stringList(item.args, 'args'),
    };
    });
  };
  const commands = parseCommands(value.commands, 'commands');
  const preparation = parseCommands(value.preparation, 'preparation');
  if (!isRecord(value.toolchain) || value.toolchain.versionEnv !== 'CI_TOOLCHAIN_VERSION' || !isRecord(value.toolchain.verify)) {
    throw new Error('adapter-materializer-toolchain-invalid');
  }
  const verify = value.toolchain.verify;
  const toolchain = {
    versionEnv: value.toolchain.versionEnv,
    verify: {
      ...(verify.id === undefined ? {} : { id: nonEmptyString(verify.id, 'command-id') }),
      command: nonEmptyString(verify.command, 'toolchain-command'),
      args: verify.args === undefined ? [] : stringList(verify.args, 'toolchain-args'),
    },
  };
  const commandIds = [...commands, ...preparation, toolchain.verify]
    .flatMap((command) => command.id === undefined ? [] : [command.id]);
  if (new Set(commandIds).size !== commandIds.length) {
    throw new Error('adapter-materializer-command-duplicate');
  }
  return {
    schemaVersion: '1',
    kind: 'ci-adapter-bundle',
    id: nonEmptyString(value.id, 'descriptor-id'),
    assets,
    commands,
    preparation,
    toolchain,
    projectSettings: {
      requiredFiles: stringList(projectSettings.requiredFiles, 'required-files', true),
      requiredScripts: stringList(projectSettings.requiredScripts, 'required-scripts', true),
    },
  };
};

const sourceAssetMap = (value: unknown): Map<string, SourceAsset> => {
  if (!isRecord(value) || !Array.isArray(value.assets)) throw new Error('adapter-materializer-inventory-invalid');
  const map = new Map<string, SourceAsset>();
  for (const item of value.assets) {
    if (!isRecord(item)) continue;
    const id = nonEmptyString(item.id, 'source-asset-id');
    const entrypoints = item.entrypoints === undefined ? [] : stringList(item.entrypoints, 'entrypoints');
    const source = item.source === undefined ? undefined : parseResourceSource(item.source, 'source');
    const copyable = item.copyable === true;
    if (map.has(id)) throw new Error(`adapter-materializer-source-asset-duplicate:${id}`);
    map.set(id, { id, entrypoints, source, copyable });
  }
  return map;
};

const findBundle = (value: unknown, bundleId: string): BundleInventory => {
  if (!isRecord(value) || !Array.isArray(value.adapterBundles)) throw new Error('adapter-materializer-inventory-invalid');
  const item = value.adapterBundles.find((candidate) => isRecord(candidate) && candidate.id === bundleId);
  if (!isRecord(item)) throw new Error(`adapter-materializer-bundle-not-found:${bundleId}`);
  return {
    id: nonEmptyString(item.id, 'bundle-id'),
    source: parseResourceSource(item.source, 'bundle-source'),
    targetDescriptor: nonEmptyString(item.targetDescriptor, 'target-descriptor'),
  };
};

const readPackageScripts = (root: string): Map<string, unknown> => {
  const packagePath = resolveInside(root, 'package.json');
  if (!fs.existsSync(packagePath)) throw new Error('adapter-materializer-project-file-missing:package.json');
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  } catch {
    throw new Error('adapter-materializer-project-file-invalid:package.json');
  }
  if (!isRecord(value) || !isRecord(value.scripts)) throw new Error('adapter-materializer-project-scripts-invalid');
  const scripts = new Map<string, unknown>();
  for (const [name, command] of Object.entries(value.scripts)) {
    scripts.set(name, command);
  }
  return scripts;
};

const unresolvedSourcePathReferences = (root: string, value: string): string[] => {
  const unresolved: string[] = [];
  for (const match of value.matchAll(/(?:^|[\s/'"`])((?:\.\.?\/)?skills\/[A-Za-z0-9._/-]+)/g)) {
    const reference = match[1];
    try {
      const resolved = resolveInside(root, reference);
      if (!fs.existsSync(resolved)) unresolved.push(reference);
    } catch {
      unresolved.push(reference);
    }
  }
  return unresolved;
};

const validateProjectSettings = (root: string, settings: AdapterDescriptor['projectSettings']): void => {
  for (const requiredFile of settings.requiredFiles) {
    const filePath = resolveInside(root, requiredFile);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new Error(`adapter-materializer-project-file-missing:${requiredFile}`);
    }
  }
  if (settings.requiredScripts.length > 0) {
    const scripts = readPackageScripts(root);
    const missing = settings.requiredScripts.filter((script) => !scripts.has(script));
    if (missing.length > 0) throw new Error(`adapter-materializer-project-scripts-missing:${missing.join(',')}`);
    const visited = new Set<string>();
    const validateScript = (script: string): void => {
      if (visited.has(script)) throw new Error(`adapter-materializer-project-script-cycle:${script}`);
      visited.add(script);
      const command = scripts.get(script);
      if (typeof command !== 'string' || command.trim().length === 0) {
        throw new Error(`adapter-materializer-project-script-invalid:${script}`);
      }
      if (unresolvedSourcePathReferences(root, command).length > 0) {
        throw new Error(`adapter-materializer-project-script-source-reference:${script}`);
      }
      for (const match of command.matchAll(/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([A-Za-z0-9:_-]+)/g)) {
        if (scripts.has(match[1])) validateScript(match[1]);
      }
      visited.delete(script);
    };
    for (const script of settings.requiredScripts) validateScript(script);
  }
};

const copyWithoutOverwrite = (source: string, destination: string): 'copied' | 'reused' => {
  let destinationStat: fs.Stats | undefined;
  try {
    destinationStat = fs.lstatSync(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (destinationStat?.isSymbolicLink()) throw new Error(`adapter-materializer-destination-symlink:${destination}`);
  if (destinationStat) {
    if (!destinationStat.isFile() || !fs.readFileSync(source).equals(fs.readFileSync(destination))) {
      throw new Error(`adapter-materializer-destination-conflict:${destination}`);
    }
    return 'reused';
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  return 'copied';
};

export type MaterializeAdapterBundleOptions = {
  sourceRoot: string;
  inventoryPath: string;
  bundleId: string;
  targetRoot: string;
  outputPath?: string;
};

export type MaterializeAdapterBundleReport = {
  schema: 'ci.adapter-materializer.v1';
  bundle: string;
  descriptor: string;
  files: Array<{ source: string; destination: string; action: 'copied' | 'reused' }>;
};

export const materializeAdapterBundle = (options: MaterializeAdapterBundleOptions): MaterializeAdapterBundleReport => {
  const sourceRoot = path.resolve(options.sourceRoot);
  const targetRoot = path.resolve(options.targetRoot);
  const inventoryPath = resolveInside(REPOSITORY_ROOT, options.inventoryPath);
  const inventory = parseYaml(inventoryPath);
  const bundle = findBundle(inventory, options.bundleId);
  const descriptorSource = resolveResource(sourceRoot, bundle.source);
  const descriptor = parseDescriptor(descriptorSource);
  if (descriptor.id !== bundle.id) throw new Error(`adapter-materializer-descriptor-id-mismatch:${bundle.id}`);
  for (const command of [...descriptor.preparation, ...descriptor.commands, descriptor.toolchain.verify]) {
    if (unresolvedSourcePathReferences(targetRoot, command.command).length > 0 || command.args.some((arg) => unresolvedSourcePathReferences(targetRoot, arg).length > 0)) {
      throw new Error('adapter-materializer-command-source-reference');
    }
  }
  const assets = sourceAssetMap(inventory);

  const plan: Array<{ source: ResourceSource; destination: string }> = [];
  for (const asset of descriptor.assets) {
    if (!asset.destination.startsWith('.ci/')) throw new Error(`adapter-materializer-destination-invalid:${asset.destination}`);
    const sourceAsset = assets.get(asset.id);
    const assetSource = sourceAsset === undefined
      ? undefined
      : sourceAsset.source ?? (sourceAsset.entrypoints.length === 1 ? sourceAsset.entrypoints[0] : undefined);
    if (!sourceAsset || !sourceAsset.copyable || assetSource === undefined) {
      throw new Error(`adapter-materializer-source-asset-unavailable:${asset.id}`);
    }
    plan.push({
      source: assetSource,
      destination: asset.destination,
    });
  }
  if (!bundle.targetDescriptor.startsWith('.ci/')) throw new Error(`adapter-materializer-target-descriptor-invalid:${bundle.targetDescriptor}`);
  plan.push({ source: bundle.source, destination: bundle.targetDescriptor });

  const sourcePlan = plan.map((item) => {
    const sourcePath = resolveResource(sourceRoot, item.source);
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
      throw new Error(`adapter-materializer-source-missing:${resourceDisplay(item.source)}`);
    }
    return { ...item, sourcePath };
  });
  if (options.outputPath) {
    const outputPath = path.resolve(options.outputPath);
    const conflict = [inventoryPath, ...sourcePlan.flatMap((item) => [
      item.sourcePath,
      resolveContainedPath(targetRoot, item.destination),
    ])].some((candidate) => pathsReferToSameFile(outputPath, candidate, 'adapter-materializer-output-path-invalid'));
    if (conflict) throw new Error(`adapter-materializer-output-conflict:${outputPath}`);
  }

  fs.mkdirSync(targetRoot, { recursive: true });
  validateProjectSettings(targetRoot, descriptor.projectSettings);
  const preparedPlan = sourcePlan.map((item) => {
    const destinationPath = resolveInside(targetRoot, item.destination);
    let destinationStat: fs.Stats | undefined;
    try {
      destinationStat = fs.lstatSync(destinationPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (destinationStat?.isSymbolicLink()) throw new Error(`adapter-materializer-destination-symlink:${destinationPath}`);
    if (destinationStat && (!destinationStat.isFile() || !fs.readFileSync(item.sourcePath).equals(fs.readFileSync(destinationPath)))) {
      throw new Error(`adapter-materializer-destination-conflict:${destinationPath}`);
    }
    return { ...item, destinationPath, action: destinationStat ? 'reused' as const : 'copied' as const };
  });
  const destinations = new Set<string>();
  for (const item of preparedPlan) {
    if (destinations.has(item.destinationPath)) throw new Error(`adapter-materializer-destination-duplicate:${item.destination}`);
    destinations.add(item.destinationPath);
  }
  const files: MaterializeAdapterBundleReport['files'] = [];
  for (const item of preparedPlan) {
    const action = copyWithoutOverwrite(item.sourcePath, item.destinationPath);
    files.push({ source: resourceDisplay(item.source), destination: item.destination, action });
  }
  return {
    schema: 'ci.adapter-materializer.v1',
    bundle: bundle.id,
    descriptor: bundle.targetDescriptor,
    files,
  };
};

const parseArgs = (args: string[]): MaterializeAdapterBundleOptions & { output?: string } => {
  if (args.length < 8 || args.length > 10) {
    throw new Error('usage: materialize-adapter-bundle.ts --source-root ROOT --inventory PATH --bundle ID --target-root ROOT [--output PATH]');
  }
  const options: Partial<MaterializeAdapterBundleOptions> & { output?: string } = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || !['--source-root', '--inventory', '--bundle', '--target-root', '--output'].includes(flag)) {
      throw new Error('usage: materialize-adapter-bundle.ts --source-root ROOT --inventory PATH --bundle ID --target-root ROOT [--output PATH]');
    }
    if (flag === '--source-root') options.sourceRoot = value;
    if (flag === '--inventory') options.inventoryPath = value;
    if (flag === '--bundle') options.bundleId = value;
    if (flag === '--target-root') options.targetRoot = value;
    if (flag === '--output') options.output = value;
  }
  if (!options.sourceRoot || !options.inventoryPath || !options.bundleId || !options.targetRoot) {
    throw new Error('usage: materialize-adapter-bundle.ts --source-root ROOT --inventory PATH --bundle ID --target-root ROOT [--output PATH]');
  }
  return options as MaterializeAdapterBundleOptions & { output?: string };
};

const main = (): void => {
  try {
    const options = parseArgs(process.argv.slice(2));
    const outputPath = resolveOutputPath(options.output);
    const report = materializeAdapterBundle({ ...options, outputPath });
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (outputPath) fs.writeFileSync(outputPath, output, 'utf8');
    else process.stdout.write(output);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'adapter-materializer-failed'}\n`);
    process.exitCode = 1;
  }
};

if (isDirectExecution(import.meta.url)) main();
