#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectActions } from './check-action-dist.mjs';

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

export const verificationPlan = (packages, nodePath = process.execPath) => packages.flatMap((entry) => [
  {
    command: 'npm',
    args: ['run', 'lint'],
    cwd: entry.path,
    action: entry.name,
    phase: 'typecheck',
  },
  {
    command: nodePath,
    args: ['--import=tsx', '--test', ...entry.tests],
    cwd: entry.path,
    action: entry.name,
    phase: 'test',
  },
]);

export const sharedRuntimeVerificationPlan = (root, nodePath = process.execPath) => {
  const actionRoot = path.join(root, 'actions/ci-gh-provisioner');
  const testPath = path.join(root, 'runtime/provisioner/tests/provision-core.test.ts');
  if (!existsSync(path.join(actionRoot, 'node_modules/tsx')) || !existsSync(testPath)) {
    throw new Error('shared provisioner verification dependencies are missing');
  }
  return [{
    command: nodePath,
    args: ['--import=tsx', '--test', path.relative(actionRoot, testPath)],
    cwd: actionRoot,
    action: 'shared-provisioner-core',
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
  const plan = [
    ...verificationPlan(packages),
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
