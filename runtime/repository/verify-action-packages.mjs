#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { collectActions } from './check-action-dist.mjs';
import { assertRuntimeBoundaries } from './check-runtime-boundaries.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(scriptDirectory, '../..');

const collectTests = (directory) => readdirSync(directory, { withFileTypes: true })
  .sort((left, right) => left.name.localeCompare(right.name))
  .flatMap((entry) => {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectTests(candidate);
    return entry.isFile() && entry.name.endsWith('.test.ts') ? [candidate] : [];
  });

export const collectActionPackages = (root, actions = collectActions(root)) => actions
  .filter((action) => action.distPath)
  .map((action) => {
    const packagePath = path.join(action.path, 'package.json');
    const lockPath = path.join(action.path, 'package-lock.json');
    const configPath = path.join(action.path, 'tsconfig.json');
    const testsRoot = path.join(action.path, 'tests');
    for (const required of [packagePath, lockPath, configPath, testsRoot]) {
      if (!existsSync(required)) throw new Error(`${action.name} is missing ${path.relative(action.path, required)}`);
    }
    const manifest = JSON.parse(readFileSync(packagePath, 'utf8'));
    if (manifest.scripts?.lint !== 'tsc --noEmit') {
      throw new Error(`${action.name} must expose the standard TypeScript lint command`);
    }
    const tests = collectTests(testsRoot);
    if (tests.length === 0) throw new Error(`${action.name} has no TypeScript tests`);
    return {
      name: action.name,
      path: action.path,
      tests: tests.map((testPath) => path.relative(action.path, testPath)),
    };
  });

export const verificationPlan = (packages, nodePath = process.execPath) => packages.flatMap((entry) => {
  const root = path.resolve(entry.path, '../..');
  return [
  {
    command: 'npm',
    args: ['run', 'lint'],
    cwd: entry.path,
    action: entry.name,
    phase: 'typecheck',
  },
  {
    command: nodePath,
    args: [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', path.join(root, 'vitest.config.mjs'), ...entry.tests.map((file) => path.join(entry.path, file))],
    cwd: entry.path,
    action: entry.name,
    phase: 'test',
  },
  ];
});

export const cliTypecheckPlan = (root, packages, nodePath = process.execPath) => {
  const require = createRequire(path.join(packages[0].path, 'package.json'));
  const typesRoot = path.dirname(path.dirname(require.resolve('@types/node/package.json')));
  return [{
    command: nodePath,
    args: [require.resolve('typescript/bin/tsc'), '--project', path.join(root, 'tsconfig.cli.json'), '--typeRoots', typesRoot],
    cwd: root,
    action: 'public-cli',
    phase: 'typecheck',
  }];
};

export const sharedRuntimeVerificationPlan = (root, nodePath = process.execPath) => {
  const actionRoot = path.join(root, 'actions/ci-gh-provisioner');
  const testPath = path.join(root, 'runtime/provisioner/tests/provision-core.test.ts');
  if (!existsSync(path.join(root, 'node_modules/vitest')) || !existsSync(testPath)) {
    throw new Error('shared provisioner verification dependencies are missing');
  }
  const releaseRoot = path.join(root, 'actions/ci-release-assembly');
  const releaseTests = ['assembly.test.mjs', 'observation.test.mjs', 'schema.test.ts', 'publisher.test.mjs', 'notes-binding.test.ts'].map((name) => path.join(root, 'runtime/release-publication/tests', name));
  if (!existsSync(path.join(root, 'node_modules/vitest')) || releaseTests.some((file) => !existsSync(file))) {
    throw new Error('shared release publication verification dependencies are missing');
  }
  const installerTest = path.join(root, 'runtime/installer/tests/common-regression.test.mjs');
  if (!existsSync(installerTest)) throw new Error('shared installer verification dependencies are missing');
  return [{
    command: nodePath,
    args: [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', path.join(root, 'vitest.config.mjs'), testPath],
    cwd: actionRoot,
    action: 'shared-provisioner-core',
    phase: 'test',
  }, {
    command: nodePath,
    args: [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', path.join(root, 'vitest.config.mjs'), ...releaseTests],
    cwd: releaseRoot,
    action: 'shared-release-publication',
    phase: 'test',
  }, {
    command: nodePath,
    args: [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', path.join(root, 'vitest.config.mjs'), installerTest],
    cwd: root,
    action: 'shared-installer',
    phase: 'test',
  }];
};

export const runVerificationPlan = (plan, execute = execFileSync) => {
  for (const step of plan) {
    process.stdout.write(`::group::${step.action} / ${step.phase}\n`);
    try {
      execute(step.command, step.args, { cwd: step.cwd, stdio: 'inherit' });
    } finally {
      process.stdout.write('::endgroup::\n');
    }
  }
};

export const verifyActionPackages = (root = defaultRoot) => {
  const packages = collectActionPackages(root);
  assertRuntimeBoundaries(root, packages);
  const plan = [
    ...verificationPlan(packages),
    ...cliTypecheckPlan(root, packages),
    ...sharedRuntimeVerificationPlan(root),
  ];
  runVerificationPlan(plan);
  process.stdout.write(`Action source verification passed (${packages.length} bundled Actions).\n`);
};

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    verifyActionPackages();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
