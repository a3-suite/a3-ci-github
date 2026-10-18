import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { describe, test, expect, onTestFinished } from 'vitest';
import { parse } from 'yaml';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = parse(fs.readFileSync(process.env.CI_CHECKOUT_WORKFLOW_FIXTURE ?? path.join(repository, '.github/workflows/ci-release-publication.yml'), 'utf8'));
const filesIn = (root) => fs.readdirSync(root, { withFileTypes: true }).flatMap(entry =>
  entry.name === '.git' ? [] : entry.isDirectory() ? filesIn(path.join(root, entry.name)) : [path.join(root, entry.name)]);
const bytesIn = (root) => fs.readdirSync(root, { withFileTypes: true }).reduce((total, entry) => {
  const filename = path.join(root, entry.name);
  return total + (entry.isDirectory() ? bytesIn(filename) : fs.statSync(filename).size);
}, 0);

const fixture = () => {
  fs.mkdirSync(path.join(repository, 'tmp'), { recursive: true });
  const root = fs.mkdtempSync(path.join(repository, 'tmp/control-checkout-'));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const globalConfig = path.join(root, 'gitconfig');
  fs.writeFileSync(globalConfig, '');
  const environment = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfig, GIT_ALLOW_PROTOCOL: 'file' };
  const git = (directory, ...args) => execFileSync('git', ['-C', directory, ...args], { env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  git(source, 'init');
  git(source, 'config', 'user.name', 'Fixture');
  git(source, 'config', 'user.email', 'fixture@example.invalid');
  git(source, 'config', 'commit.gpgsign', 'false');
  git(source, 'config', 'core.hooksPath', path.join(root, 'no-hooks'));
  git(source, 'config', 'uploadpack.allowFilter', 'true');
  const manifests = ['.ci/platforms.yml', 'platforms.yml', 'custom path/platform [literal]*?#!.yml', 'platforms.yml ', 'platforms.yml\t', 'platforms.yml\u00a0'];
  for (const filename of manifests) {
    fs.mkdirSync(path.dirname(path.join(source, filename)), { recursive: true });
    fs.writeFileSync(path.join(source, filename), 'platforms: []\n# trusted control\n');
  }
  fs.mkdirSync(path.join(source, 'product'));
  fs.writeFileSync(path.join(source, 'product/large.bin'), randomBytes(2 * 1024 * 1024));
  fs.writeFileSync(path.join(source, 'README.md'), 'unneeded control checkout file\n');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'control fixture');
  const controlSha = git(source, 'rev-parse', 'HEAD');
  for (const filename of manifests) fs.appendFileSync(path.join(source, filename), '# later product source\n');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'product fixture');
  const productSha = git(source, 'rev-parse', 'HEAD');
  const checkout = (pattern, name) => {
    pattern = pattern?.trim();
    const destination = path.join(root, name);
    fs.mkdirSync(destination);
    git(destination, 'init');
    git(destination, 'remote', 'add', 'origin', pathToFileURL(source).href);
    git(destination, '-c', 'protocol.version=2', 'fetch', '--no-tags', '--depth=1', ...(pattern ? ['--filter=blob:none'] : []), 'origin', controlSha);
    if (pattern) {
      git(destination, 'config', 'core.sparseCheckout', 'true');
      fs.mkdirSync(path.join(destination, '.git/info'), { recursive: true });
      fs.writeFileSync(path.join(destination, '.git/info/sparse-checkout'), `\n${pattern}\n`);
    }
    git(destination, 'checkout', '--detach', 'FETCH_HEAD');
    return destination;
  };
  const scope = (manifest) => {
    const step = workflow.jobs.assemble.steps.find(entry => entry.id === 'control-checkout-scope');
    if (!step) return { status: 0, pattern: undefined };
    const output = path.join(root, 'scope-output');
    fs.writeFileSync(output, '');
    const result = spawnSync('bash', ['-c', step.run], { env: { ...environment, ...step.env, CI_PLATFORM_MANIFEST: manifest, GITHUB_OUTPUT: output }, encoding: 'utf8' });
    return { ...result, pattern: fs.readFileSync(output, 'utf8').replace(/^pattern=/, '').replace(/\n$/, '') };
  };
  const verify = (directory, sha) => {
    const step = workflow.jobs.publish.steps.find(entry => entry.name === 'Verify trusted control checkout');
    return spawnSync('bash', ['-c', step.run], { cwd: directory, env: { ...environment, CONTROL_SHA: sha }, encoding: 'utf8' });
  };
  return { root, source, controlSha, productSha, git, checkout, scope, verify };
};

export { repository, workflow, filesIn, bytesIn, fixture };
