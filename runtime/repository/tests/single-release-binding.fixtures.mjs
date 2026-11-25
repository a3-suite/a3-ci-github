import { expect, onTestFinished, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';
import { registryPath } from '../check-provider-references.mjs';
// Synchronous child processes block the worker, so Vitest's testTimeout cannot interrupt them; bound each call.
// Calls take up to 1.7s alone but over 7s under full-regression load; the limit is about 5x that load maximum.
// A timeout means the call regressed: investigate its performance or split it before raising the limit.
const spawnTimeoutMs = 35000;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const failure = (operation) => { try { operation(); } catch (error) { return error.message; } };
const access = (directory) => ({
  directory,
  git: (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: 'pipe', timeout: spawnTimeoutMs }).trim(),
  write: (relative, bytes) => { mkdirSync(path.dirname(path.join(directory, relative)), { recursive: true }); writeFileSync(path.join(directory, relative), bytes); },
});
let seed;
let implementation;
beforeAll(() => {
  mkdirSync(path.join(root, 'tmp'), { recursive: true });
  seed = mkdtempSync(path.join(root, 'tmp/single-release-binding-seed-'));
  const { git, write } = access(seed);
  git('init', '-b', 'main'); git('config', 'user.name', 'Binding Test'); git('config', 'user.email', 'binding@example.invalid'); git('config', 'commit.gpgsign', 'false'); git('config', 'core.autocrlf', 'false');
  const zero = '0'.repeat(40);
  const registry = yaml.parse(readFileSync(path.join(root, registryPath), 'utf8'));
  registry.actionization.implementationSource = { repository: 'a3-suite/a3-ci-github', releaseTag: 'v0.2.10', exactRef: zero };
  const steps = ['ci-quality-adapter', 'ci-release-publication-control', 'ci-jq-provisioner', 'ci-github-toolchain-verifier'].map((name) => {
    const actionPath = `actions/${name}`;
    const action = yaml.parse(readFileSync(path.join(root, actionPath, 'action.yml'), 'utf8'));
    write(`${actionPath}/action.yml`, readFileSync(path.join(root, actionPath, 'action.yml')));
    if (action.runs.main) {
      write(`${actionPath}/${action.runs.main}`, readFileSync(path.join(root, actionPath, action.runs.main)));
      // The ESM dist runs only with the module scope that ncc writes beside it.
      const scope = path.posix.join(path.posix.dirname(action.runs.main), 'package.json');
      if (existsSync(path.join(root, actionPath, scope))) write(`${actionPath}/${scope}`, readFileSync(path.join(root, actionPath, scope)));
    }
    return { uses: `a3-suite/a3-ci-github/${actionPath}@${zero}`, env: { A3_INSTALLER_PROVIDER_REVISION: zero }, with: Object.fromEntries(Object.entries(action.inputs).filter(([, value]) => value.required && !Object.hasOwn(value, 'default')).map(([key]) => [key, 'fixed'])) };
  });
  write(registryPath, yaml.stringify(registry)); write('VERSION', '0.2.10\n'); write('runtime/payload.mjs', 'export const payload = 1;\n');
  write('runtime/github-toolchain/verify-github-toolchain.sh', readFileSync(path.join(root, 'runtime/github-toolchain/verify-github-toolchain.sh')));
  write('actions/ci-quality-adapter/scripts/composite.sh', '#!/bin/sh\nexit 0\n');
  for (const name of ['ci-quality', 'ci-quality-platforms', 'ci-package-preparation', 'ci-release-publication', 'ci-package-publication']) write(`.github/workflows/${name}.yml`, yaml.stringify({ jobs: { checked: { steps } } }));
  git('add', '.'); git('commit', '-m', 'base');
  write('VERSION', '0.2.11\n'); git('add', '.'); git('commit', '-m', 'implementation');
  implementation = git('rev-parse', 'HEAD');
});
afterAll(() => { if (seed) rmSync(seed, { recursive: true, force: true }); });
const fixture = () => {
  const directory = mkdtempSync(path.join(root, 'tmp/single-release-binding-'));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  // Copy the index, refs and objects too: each case mutates a fully isolated real repository.
  cpSync(seed, directory, { recursive: true });
  return { ...access(directory), implementation };
};

// The reference update CLI and the provider reference check CLI are the publication surfaces these cases observe.
const runScript = (script, directory, args) => spawnSync(process.execPath, [path.join(root, 'runtime/repository', script), ...args], { cwd: directory, encoding: 'utf8', timeout: spawnTimeoutMs });
const scriptReport = (result) => {
  expect(result.error).toBeUndefined();
  if (result.status === 0 || result.status === 1) return JSON.parse(result.stdout);
  throw new Error(result.stderr);
};
const updateReferences = (directory, sha, mode = '--write') => scriptReport(runScript('update-action-references.mjs', directory, [mode, '--tag', 'v0.2.11', '--implementation-sha', sha]));
const checkReferences = (directory, ...args) => scriptReport(runScript('check-provider-references.mjs', directory, ['--contracts', ...args]));
const checkRelease = (directory) => checkReferences(directory, '--release-tag', 'v0.2.11');

export { root, spawnTimeoutMs, failure, fixture, runScript, updateReferences, checkReferences, checkRelease };
