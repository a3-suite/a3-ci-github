import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { beforeAll, afterAll, expect, test, vi, describe } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  applyDistributionPlan,
  fetchDistribution,
  loadDistributionManifest,
  planDistributionApplication as createDistributionPlan,
  resolveDistributionSelection,
  rollbackDistributionTransaction,
  validateDistributionManifest,
  verifyFetchedDistribution,
} from '../fetch-a3-ci-github.mjs';
import { snapshotTree } from '../../preset/tests/support/release-request-fixture.mjs';
import { readWorkflowSettings, renderWorkflowTemplate } from '../../preset/workflow-template.mjs';

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testRoot, '../../..');
const tsx = path.join(repositoryRoot, 'runtime/preset/node_modules/.bin/tsx');
const yaml = createRequire(path.join(repositoryRoot, 'runtime/preset/package.json'))('yaml');
const fixtureSettings = {
  'protected-branch': ['main'], 'versioned-runner': 'ubuntu-24.04', 'language-profile': 'typescript',
  'toolchain-version': '24.0.0', 'uv-version': '', 'cargo-audit-version': '', 'cargo-manifest-path': '',
  'cargo-lock-path': '', 'optional-jq-version': '', 'standard-bundle-id': 'typescript-npm-quality',
  'adapter-descriptor': '', 'release-tag-pattern': 'v*',
  'platform-manifest': '.ci/platform-manifest.yml', 'gh-version': '2.80.0', 'jq-version': '1.7.1',
  'release-implementation': 'rust-cli', 'release-binary-name': '', 'release-asset-prefix': '',
  'supplemental-release-asset-enabled': false, 'supplemental-release-asset-owner-contract': 'owner-v2',
  'supplemental-release-asset-implementation': 'owner-adapter', 'supplemental-release-asset-config-path': '.ci/installer.yml',
  'release-skills-config-path': '__unset__',
  'quality-profiles': [
    { 'language-profile': 'rust', 'toolchain-version': '1.90.0', 'uv-version': '', 'cargo-audit-version': '0.21.0',
      'cargo-manifest-path': 'Cargo.toml', 'cargo-lock-path': 'Cargo.lock', 'cargo-deny-version': '', 'cargo-deny-config-path': '',
      'jq-version': '', 'standard-bundle-id': 'rust-cargo-quality', 'adapter-descriptor': '' },
    { 'language-profile': 'python', 'toolchain-version': '3.13.1', 'uv-version': '0.8.0', 'cargo-audit-version': '',
      'cargo-manifest-path': '', 'cargo-lock-path': '', 'cargo-deny-version': '', 'cargo-deny-config-path': '',
      'jq-version': '', 'standard-bundle-id': '', 'adapter-descriptor': '.ci/adapters/python-quality.yml' },
  ],
};
const planDistributionApplication = (options) => {
  const distributionRoot = path.join(options.projectRoot, '.a3-skills/ci-github/distributions', options.sourceRevision);
  const manifest = JSON.parse(fs.readFileSync(path.join(distributionRoot, 'manifest.json')));
  const settings = {};
  const values = { ...fixtureSettings, ...options.settingOverrides };
  for (const asset of resolveDistributionSelection(manifest, options.requestedPresets, options.requestedAssets).filter((asset) => asset.application === 'copy')) {
    const template = fs.readFileSync(path.join(distributionRoot, asset.files[0].sourcePath), 'utf8');
    settings[asset.id] = Object.fromEntries([...new Set([...template.matchAll(/<([a-zA-Z][a-zA-Z0-9._-]*)>/g)].map((match) => match[1]))]
      .filter((key) => Object.hasOwn(values, key)).map((key) => [key, values[key]]));
  }
  return createDistributionPlan({ yaml, settings, ...options });
};
const fixtureVersion = '1.2.3';
const releaseTag = `v${fixtureVersion}`;
const temporaryRoot = path.join(repositoryRoot, 'tmp');
// Created in beforeAll, not at import: collection-only runs (such as resolve-test-targets) never run afterAll,
// so a module-level copy of the source tree would be left behind on every such run.
let committedSourceRoot;
let sourceRevision;
const runFixtureGit = (args) => {
  const result = spawnSync('git', args, { cwd: committedSourceRoot, encoding: 'utf8', timeout: 5000 });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
};
beforeAll(() => {
  fs.mkdirSync(temporaryRoot, { recursive: true });
  committedSourceRoot = fs.mkdtempSync(path.join(temporaryRoot, 'distribution-source-'));
  for (const relative of [
    'VERSION',
    '.ci/release-skills.json',
    '.github/workflows/ci-quality.yml',
    '.github/workflows/ci-quality-platforms.yml',
    '.github/workflows/ci-package-preparation.yml',
    '.github/workflows/ci-release-publication.yml',
    '.github/workflows/ci-asset-release-publication.yml',
    '.github/workflows/ci-package-publication.yml',
    'skills/ci-github',
    'skills/ci-release-installer',
    'runtime/installer',
    'runtime/release-publication/selection.ts',
    'workflows',
    'runtime/preset',
    'runtime/platform',
    'runtime/release-publication/evidence.schema.json',
    'runtime/adapter',
    'runtime/path',
    'runtime/distribution',
    'runtime/diagnostics',
    'lint-rules/a3-lint',
  ]) {
    const source = path.join(repositoryRoot, relative);
    const destination = path.join(committedSourceRoot, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(source, destination, {
      recursive: true,
      filter: (candidate) => !path.relative(source, candidate).split(path.sep).some((part) => ['node_modules', '__pycache__', 'tmp'].includes(part)),
    });
  }
  fs.writeFileSync(path.join(committedSourceRoot, 'VERSION'), `${fixtureVersion}\n`);
  runFixtureGit(['init', '-q']);
  runFixtureGit(['config', 'user.name', 'Distribution Test']);
  runFixtureGit(['config', 'user.email', 'distribution-test@example.invalid']);
  runFixtureGit(['add', '--all']);
  runFixtureGit(['commit', '-qm', 'fixture']);
  sourceRevision = runFixtureGit(['rev-parse', 'HEAD']);
});
let baselineRoot;
afterAll(() => {
  if (baselineRoot) fs.rmSync(baselineRoot, { recursive: true, force: true });
  if (committedSourceRoot) fs.rmSync(committedSourceRoot, { recursive: true, force: true });
});
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const withFixture = async (name, callback) => {
  const root = fs.mkdtempSync(path.join(temporaryRoot, name));
  try {
    return await callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const readRelease = (output) => ({
  output,
  manifestPath: path.join(output, 'a3-ci-github-distribution-manifest.json'),
  manifestBytes: fs.readFileSync(path.join(output, 'a3-ci-github-distribution-manifest.json')),
  manifest: JSON.parse(fs.readFileSync(path.join(output, 'a3-ci-github-distribution-manifest.json'), 'utf8')),
});

const generateRelease = (root) => {
  const output = path.join(root, 'release');
  const result = spawnSync(tsx, [
    path.join(repositoryRoot, 'runtime/distribution/generate-distribution-release.ts'),
    '--repository-root', committedSourceRoot,
    '--output-directory', output,
    '--source-revision', sourceRevision,
    '--release-tag', releaseTag,
  ], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return readRelease(output);
};

let baseline;
beforeAll(() => {
  baselineRoot = fs.mkdtempSync(path.join(temporaryRoot, 'distribution-baseline-'));
  baseline = generateRelease(baselineRoot);
});

const prepareRelease = (root) => {
  const output = path.join(root, 'release');
  expect(fs.existsSync(output)).toBe(false);
  fs.cpSync(baseline.output, output, { recursive: true, force: false, errorOnExist: true });
  return readRelease(output);
};

export { testRoot, repositoryRoot, tsx, yaml, fixtureSettings, planDistributionApplication, fixtureVersion, releaseTag, temporaryRoot, committedSourceRoot, sourceRevision, runFixtureGit, baselineRoot, sha256, withFixture, readRelease, generateRelease, baseline, prepareRelease };
