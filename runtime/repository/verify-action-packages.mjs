#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { collectActions } from './check-action-dist.mjs';
import { assertRuntimeBoundaries } from './check-runtime-boundaries.mjs';
import { completeFailure, DiagnosticError, FailureContext, safeErrorReason } from '../diagnostics/failure.mjs';

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
      if (!existsSync(required)) throw new DiagnosticError(`${action.name} is missing ${path.relative(action.path, required)}`, { diagnosticCode: 'action-source-input-missing', diagnostics: { action: action.name, field: path.relative(action.path, required), expected: 'present', observed: 'missing' } });
    }
    const manifest = JSON.parse(readFileSync(packagePath, 'utf8'));
    if (manifest.scripts?.lint !== 'tsc --noEmit') {
      throw new DiagnosticError(`${action.name} must expose the standard TypeScript lint command`, { diagnosticCode: 'action-source-typecheck-invalid', diagnostics: { action: action.name, field: 'scripts.lint', expected: 'standard-typecheck', observed: 'invalid' } });
    }
    const tests = collectTests(testsRoot);
    if (tests.length === 0) throw new DiagnosticError(`${action.name} has no TypeScript tests`, { diagnosticCode: 'action-source-tests-missing' });
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

export const runVerificationPlan = (plan, execute = execFileSync, diagnostic = new FailureContext('repository-action-distribution', 'source-verification')) => {
  for (const [index, step] of plan.entries()) {
    diagnostic.at(step.phase, { action: step.action, input: 'action-source-and-contract-tests', completedSteps: index, remainingSteps: plan.length - index });
    try { process.stdout.write(`::group::${step.action} / ${step.phase}\n`); } catch { /* Group markers cannot mask the verification result. */ }
    try {
      diagnostic.writeState = 'verification-local-artifacts-possible';
      execute(step.command, step.args, { cwd: step.cwd, stdio: 'inherit' });
      diagnostic.confirmed();
    } catch (error) {
      throw new DiagnosticError('Action source verification failed', {
        diagnosticCode: 'action-source-verification-failed', cause: error,
        diagnostics: { field: step.action, expected: 'zero-exit', observed: typeof error?.status === 'number' ? error.status : safeErrorReason(error), completedSteps: index, remainingSteps: plan.length - index },
      });
    } finally {
      try { process.stdout.write('::endgroup::\n'); } catch { /* Preserve a child failure when closing the log group fails. */ }
    }
  }
};

export const verifyActionPackages = (root = defaultRoot, diagnostic = new FailureContext('repository-action-distribution', 'source-verification')) => {
  diagnostic.at('action-inventory', { input: 'actions-and-package-metadata' });
  const packages = collectActionPackages(root);
  diagnostic.confirmed();
  diagnostic.at('runtime-boundaries', { input: 'action-import-dependencies', actionCount: packages.length });
  assertRuntimeBoundaries(root, packages);
  diagnostic.confirmed();
  diagnostic.at('verification-plan', { input: 'source-typechecks-and-contract-tests' });
  const plan = [
    ...verificationPlan(packages),
    ...cliTypecheckPlan(root, packages),
    ...sharedRuntimeVerificationPlan(root),
  ];
  diagnostic.confirmed();
  runVerificationPlan(plan, execFileSync, diagnostic);
  diagnostic.at('result-output', { output: 'stdout-verification-result' });
  process.stdout.write(`Action source verification passed (${packages.length} bundled Actions).\n`);
};

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const diagnostic = new FailureContext('repository-action-distribution', 'source-verification');
  try {
    verifyActionPackages(defaultRoot, diagnostic);
  } catch (error) {
    process.exitCode = 1;
    const reason = diagnostic.report(error);
    completeFailure(reason, 1);
  }
}
