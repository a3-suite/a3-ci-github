// Contract tests observe preset assurance through its public CLIs; these wrappers keep the call shape
// of the module functions and return the stdout report, or throw with the stderr diagnostic.
import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';

const presetRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repositoryRoot = path.resolve(presetRoot, '../..');
const defaultRuntimeRoot = process.env.CI_GITHUB_PREFLIGHT_RUNTIME_ROOT ?? presetRoot;
const tsx = createRequire(path.join(presetRoot, 'package.json')).resolve('tsx');
const registryPath = 'skills/ci-github/assets/registry/ci-github-preset-assets.yml';

const runPresetCli = (runtimeRoot, script, args) => spawnSync(process.execPath, ['--import', tsx, path.join(runtimeRoot, script), ...args], { encoding: 'utf8' });
const flags = (entries) => entries.flatMap(([flag, value]) => (value === undefined ? [] : [flag, value]));

export const validateCiPresetCli = ({ repoRoot, presets = [], skillCollectionRoot, runtimeRoot = defaultRuntimeRoot }) => {
  const result = runPresetCli(runtimeRoot, 'validate-ci-preset.ts', [
    ...flags([['--repo-root', repoRoot], ['--skill-collection-root', skillCollectionRoot]]), ...presets.flatMap((preset) => ['--preset', preset]),
  ]);
  if (result.status === 0 || result.status === 1) return JSON.parse(result.stdout);
  throw new Error(result.stderr);
};

export const writeCiAssetLockCli = ({ repoRoot, sourceRevision, releaseTag, skillCollectionRoot, runtimeRoot = defaultRuntimeRoot }) => {
  const result = runPresetCli(runtimeRoot, 'generate-ci-asset-lock.ts', flags([
    ['--repo-root', repoRoot], ['--skill-collection-root', skillCollectionRoot], ['--source-revision', sourceRevision], ['--release-tag', releaseTag],
  ]));
  if (result.status === 0) return JSON.parse(result.stdout);
  throw new Error(result.stderr);
};

// The Action target registry is provider release state, so a case that needs a different state runs the CLI
// from a provider copy whose registry carries it. Returns the preset runtime root of that copy.
export const providerWithActionStatus = (root, statuses) => {
  const provider = path.join(root, 'provider');
  for (const relative of ['runtime/preset', 'runtime/diagnostics', 'runtime/path', 'runtime/adapter', 'runtime/platform', 'runtime/release-publication', 'skills/ci-github', 'workflows', '.github/workflows']) {
    cpSync(path.join(repositoryRoot, relative), path.join(provider, relative), {
      recursive: true,
      filter: (source) => !path.relative(path.join(repositoryRoot, relative), source).split(path.sep).some((part) => ['node_modules', 'tests', 'tmp'].includes(part)),
    });
  }
  symlinkSync(path.join(presetRoot, 'node_modules'), path.join(provider, 'runtime/preset/node_modules'));
  const registry = parse(readFileSync(path.join(provider, registryPath), 'utf8'));
  for (const [id, status] of Object.entries(statuses)) {
    const target = registry.actionization.targets.find((entry) => entry.id === id);
    if (!target) throw new Error(`unknown Action target: ${id}`);
    target.status = status;
  }
  mkdirSync(path.dirname(path.join(provider, registryPath)), { recursive: true });
  writeFileSync(path.join(provider, registryPath), stringify(registry));
  return path.join(provider, 'runtime/preset');
};
