import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';

type CommandSpec = { id: string; command: string; args?: string[] };
type CommandResult = CommandSpec & { status: 'success' | 'failed' | '判定不能'; exitCode: number | null; stdout: string; stderr: string };
type ProjectSettings = { requiredFiles: string[]; requiredScripts: string[]; requiredEnvironmentPaths: string[] };
type Toolchain = { versionEnv: string; verify: CommandSpec };
export type AdapterBundle = {
  schemaVersion: string; kind: string; id: string; contract: string; languageProfiles: string[];
  provider: string; executionBoundary: 'read-only'; sourceCheckout: 'fixed-source'; copyable: boolean; owner: string;
  assets: { id: string; destination: string }[]; projectSettings: ProjectSettings; toolchain: Toolchain;
  preparation: CommandSpec[]; commands: CommandSpec[];
};
export type AdapterOptions = {
  sourceRoot: string; languageProfile?: string; toolchainVersion: string;
  requireTrustedProjectScripts: boolean; trustedProjectRoot?: string; environment?: NodeJS.ProcessEnv;
};
export type AdapterPayload = { schema: 'ci.adapter-runner.v1'; adapter: string; contract: string; languageProfiles: string[]; status: 'success' | 'failed' | '判定不能'; results: CommandResult[] };

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value)) throw new Error(`quality-adapter-${field}-invalid`);
  return value;
};
const strings = (value: unknown, field: string, optional = false): string[] => {
  if (value === undefined && optional) return [];
  if (!Array.isArray(value) || (!optional && value.length === 0)) throw new Error(`quality-adapter-${field}-invalid`);
  return value.map((item) => text(item, field));
};
const command = (value: unknown, fallbackId: string, taken: Set<string>): CommandSpec => {
  if (!record(value)) throw new Error('quality-adapter-command-invalid');
  let id: string;
  if (value.id === undefined) {
    let candidate = fallbackId;
    let suffix = 1;
    while (taken.has(candidate)) candidate = `${fallbackId}-${suffix++}`;
    id = candidate;
  } else {
    id = text(value.id, 'command-id');
  }
  taken.add(id);
  return { id, command: text(value.command, 'command'), ...(value.args === undefined ? {} : { args: strings(value.args, 'args') }) };
};
const commands = (value: unknown, field: string, taken: Set<string>): CommandSpec[] => {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`quality-adapter-${field}-invalid`);
  return value.map((item, index) => command(item, `${field}-${index}`, taken));
};
const hasSkillPath = (value: string): boolean => /(?:^|[\s/'"`])(?:\.\.?\/)?skills\//.test(value);
const versionTokenPresent = (output: string, version: string): boolean =>
  output.split(/[ \t\n\r]+/).some((token) => token === version || token === `v${version}` || token === `V${version}`);

export const parseAdapterBundle = (content: string): AdapterBundle => {
  const document = parseDocument(content, { prettyErrors: false });
  if (document.errors.length) throw new Error('quality-adapter-yaml-invalid');
  const value = document.toJS();
  if (!record(value) || value.schemaVersion !== '1' || value.kind !== 'ci-adapter-bundle') throw new Error('quality-adapter-metadata-invalid');
  if (!record(value.projectSettings) || !record(value.toolchain) || !record(value.toolchain.verify)) throw new Error('quality-adapter-structure-invalid');
  if (value.executionBoundary !== 'read-only') throw new Error('quality-adapter-execution-boundary-invalid');
  if (value.sourceCheckout !== 'fixed-source') throw new Error('quality-adapter-source-checkout-invalid');
  if (typeof value.copyable !== 'boolean') throw new Error('quality-adapter-copyable-invalid');
  if (value.toolchain.versionEnv !== 'CI_TOOLCHAIN_VERSION') throw new Error('quality-adapter-toolchain-invalid');
  if (!Array.isArray(value.assets)) throw new Error('quality-adapter-assets-invalid');
  const assets = value.assets.map((item) => {
    if (!record(item) || item.source !== undefined) throw new Error('quality-adapter-asset-invalid');
    return { id: text(item.id, 'asset-id'), destination: text(item.destination, 'asset-destination') };
  });
  const commandIds = new Set<string>();
  const reserveCommandId = (entry: unknown): void => {
    if (!record(entry) || entry.id === undefined) return;
    commandIds.add(text(entry.id, 'command-id'));
  };
  for (const entry of Array.isArray(value.preparation) ? value.preparation : []) reserveCommandId(entry);
  for (const entry of Array.isArray(value.commands) ? value.commands : []) reserveCommandId(entry);
  if (record(value.toolchain.verify)) reserveCommandId(value.toolchain.verify);
  const bundle: AdapterBundle = {
    schemaVersion: '1', kind: 'ci-adapter-bundle', id: text(value.id, 'id'), contract: text(value.contract, 'contract'),
    languageProfiles: strings(value.languageProfiles, 'language-profiles'), provider: text(value.provider, 'provider'),
    executionBoundary: 'read-only', sourceCheckout: 'fixed-source', copyable: value.copyable, owner: text(value.owner, 'owner'), assets,
    projectSettings: { requiredFiles: strings(value.projectSettings.requiredFiles, 'required-files', true), requiredScripts: strings(value.projectSettings.requiredScripts, 'required-scripts', true), requiredEnvironmentPaths: strings(value.projectSettings.requiredEnvironmentPaths, 'required-environment-paths', true) },
    toolchain: { versionEnv: 'CI_TOOLCHAIN_VERSION', verify: command(value.toolchain.verify, 'toolchain-verify', commandIds) },
    preparation: commands(value.preparation, 'preparation', commandIds), commands: commands(value.commands, 'commands', commandIds),
  };
  if (bundle.contract !== 'quality-scripts') throw new Error('quality-adapter-contract-invalid');
  const ids = new Set<string>();
  const assetIds = new Set<string>();
  for (const asset of bundle.assets) {
    if (assetIds.has(asset.id)) throw new Error(`quality-adapter-asset-duplicate:${asset.id}`);
    assetIds.add(asset.id);
    if (!asset.destination.startsWith('.ci/')) throw new Error('quality-adapter-asset-destination-invalid');
  }
  for (const spec of [...bundle.preparation, ...bundle.commands, bundle.toolchain.verify]) {
    if (ids.has(spec.id)) throw new Error(`quality-adapter-command-duplicate:${spec.id}`);
    ids.add(spec.id);
    if (hasSkillPath(spec.command) || (spec.args ?? []).some(hasSkillPath)) throw new Error('quality-adapter-command-source-reference');
  }
  return bundle;
};

export const loadAdapterBundle = (bundlePath: string): AdapterBundle => parseAdapterBundle(fs.readFileSync(bundlePath, 'utf8'));

const packageScripts = (root: string): Record<string, string> => {
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch { throw new Error('quality-adapter-package-json-missing'); }
  if (!record(value) || !record(value.scripts)) throw new Error('quality-adapter-package-scripts-missing');
  const scripts: Record<string, string> = {};
  for (const [name, command] of Object.entries(value.scripts)) {
    if (typeof command !== 'string' || command.length === 0) throw new Error(`quality-adapter-package-script-invalid:${name}`);
    scripts[name] = command;
  }
  return scripts;
};

const verifyPaths = (settings: ProjectSettings, root: string, environment: NodeJS.ProcessEnv): void => {
  const realRoot = fs.realpathSync(root);
  for (const name of settings.requiredEnvironmentPaths) {
    if (!/^CI_[A-Z0-9_]+$/.test(name)) throw new Error(`quality-adapter-environment-path-name-invalid:${name}`);
    const value = environment[name];
    if (!value || path.isAbsolute(value) || /[\0\r\n]/.test(value)) throw new Error(`quality-adapter-environment-path-invalid:${name}`);
    const absolute = path.resolve(root, value);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) throw new Error(`quality-adapter-environment-path-missing:${name}`);
    const relative = path.relative(realRoot, fs.realpathSync(absolute));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`quality-adapter-environment-path-outside-root:${name}`);
  }
};

const prepareCommand = (spec: CommandSpec, environment: NodeJS.ProcessEnv, allowedPaths: string[]): CommandSpec & { args: string[] } => {
  const allowed = new Set(['CI_TOOLCHAIN_VERSION', ...allowedPaths]);
  const args = (spec.args ?? []).map((arg) => arg.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_match, name: string) => {
    if (!allowed.has(name)) throw new Error(`quality-adapter-environment-reference-forbidden:${name}`);
    return environment[name] ?? '';
  }));
  return { ...spec, args };
};

const runCommand = (spec: CommandSpec & { args: string[] }, root: string, environment: NodeJS.ProcessEnv): CommandResult => {
  const result = spawnSync(spec.command, spec.args, { cwd: root, encoding: 'utf8', shell: false, env: environment });
  return { ...spec, status: result.error ? '判定不能' : result.status === 0 ? 'success' : 'failed', exitCode: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? result.error?.message ?? '' };
};

export const executeAdapter = (bundle: AdapterBundle, options: AdapterOptions): AdapterPayload => {
  const sourceRoot = fs.realpathSync(options.sourceRoot);
  const environment = { ...(options.environment ?? process.env), CI_TOOLCHAIN_VERSION: options.toolchainVersion };
  if (!options.toolchainVersion || /[\0\r\n]/.test(options.toolchainVersion)) throw new Error('quality-adapter-toolchain-version-missing');
  if (options.languageProfile && !bundle.languageProfiles.includes(options.languageProfile)) throw new Error('quality-adapter-language-profile-mismatch');
  if (options.requireTrustedProjectScripts && bundle.projectSettings.requiredScripts.length) {
    if (!options.trustedProjectRoot) throw new Error('quality-adapter-trusted-project-root-missing');
    const current = packageScripts(sourceRoot);
    const trusted = packageScripts(fs.realpathSync(options.trustedProjectRoot));
    for (const name of bundle.projectSettings.requiredScripts) if (current[name] === undefined || current[name] !== trusted[name]) throw new Error(`quality-adapter-project-script-binding-mismatch:${name}`);
  }
  verifyPaths(bundle.projectSettings, sourceRoot, environment);
  const verifyCommand = prepareCommand(bundle.toolchain.verify, environment, []);
  const preparationCommands = bundle.preparation.map((spec) => prepareCommand(spec, environment, bundle.projectSettings.requiredEnvironmentPaths));
  const commands = bundle.commands.map((spec) => prepareCommand(spec, environment, bundle.projectSettings.requiredEnvironmentPaths));
  const results: CommandResult[] = [];
  const verify = runCommand(verifyCommand, sourceRoot, environment);
  if (verify.status !== '判定不能') {
    const received = `${verify.stdout}\n${verify.stderr}`;
    const reportsVersion = verify.status === 'success' && versionTokenPresent(received, options.toolchainVersion);
    if (!reportsVersion) {
      Object.assign(verify, {
        status: 'failed',
        stderr: `quality-adapter-toolchain-version-mismatch: expected=${options.toolchainVersion} or v${options.toolchainVersion} or V${options.toolchainVersion} received=${received}`,
      });
    }
  }
  results.push(verify);
  if (verify.status === 'success') {
    for (const spec of preparationCommands) {
      const result = runCommand(spec, sourceRoot, environment);
      results.push(result);
      if (result.status !== 'success') break;
    }
    if (results.every((result) => result.status === 'success')) for (const spec of commands) results.push(runCommand(spec, sourceRoot, environment));
  }
  const status = results.some((result) => result.status === 'failed') ? 'failed' : results.some((result) => result.status === '判定不能') ? '判定不能' : 'success';
  return { schema: 'ci.adapter-runner.v1', adapter: bundle.id, contract: bundle.contract, languageProfiles: bundle.languageProfiles, status, results };
};
