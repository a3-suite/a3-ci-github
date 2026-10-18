#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { collectActions } from './check-action-dist.mjs';
import { assertRuntimeBoundaries } from './check-runtime-boundaries.mjs';
import { completeFailure, DiagnosticError, FailureContext, safeErrorReason } from '../diagnostics/failure.mjs';
import { classifyVitestReport, parseVitestReport } from '../vitest/vitest-report-core.mjs';

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

export const batchActionTypecheckPlan = (plan, packages, nodePath = process.execPath) => {
  const candidates = packages.filter((entry) => {
    const config = JSON.parse(readFileSync(path.join(entry.path, 'tsconfig.json'), 'utf8'));
    return Object.keys(config).sort().join(',') === 'extends,include'
      && config.extends === '../../tsconfig.action.json'
      && JSON.stringify(config.include) === '["src/**/*.ts","tests/**/*.ts"]';
  }).map((entry) => {
    const require = createRequire(path.join(entry.path, 'package.json'));
    const versions = ['typescript/package.json', '@types/node/package.json'].map((name) => JSON.parse(readFileSync(require.resolve(name), 'utf8')).version);
    return { ...entry, compiler: require.resolve('typescript/bin/tsc'), versions: JSON.stringify(versions) };
  });
  if (candidates.length < 2) return plan;
  const selected = candidates.filter((entry) => entry.versions === candidates[0].versions);
  if (selected.length < 2) return plan;
  const names = new Set(selected.map((entry) => entry.name));
  // Keep each original project boundary; --force never substitutes a cached successful typecheck.
  return plan.flatMap((step) => {
    if (step.phase !== 'typecheck' || !names.has(step.action)) return [step];
    if (step.action !== selected[0].name) return [];
    return [{ command: nodePath,
      args: [selected[0].compiler, '--build', ...selected.map((entry) => path.join(entry.path, 'tsconfig.json')), '--force'],
      cwd: path.resolve(selected[0].path, '../..'), action: 'standard-action-projects', phase: 'typecheck' }];
  });
};

export const sharedRuntimeVerificationPlan = (root, nodePath = process.execPath) => {
  const actionRoot = path.join(root, 'actions/ci-gh-provisioner');
  const testPath = path.join(root, 'runtime/provisioner/tests/provision-core.test.ts');
  if (!existsSync(path.join(root, 'node_modules/vitest')) || !existsSync(testPath)) {
    throw new Error('shared provisioner verification dependencies are missing');
  }
  const releaseRoot = path.join(root, 'actions/ci-release-assembly');
  const releaseTests = ['assembly.test.mjs', 'observation.test.mjs', 'observation-policy.test.mjs', 'schema.test.ts', 'publisher.test.mjs', 'notes-binding.test.ts', 'skill-zip.test.ts'].map((name) => path.join(root, 'runtime/release-publication/tests', name));
  if (!existsSync(path.join(root, 'node_modules/vitest')) || releaseTests.some((file) => !existsSync(file))) {
    throw new Error('shared release publication verification dependencies are missing');
  }
  const installerTest = path.join(root, 'runtime/installer/tests/common-regression.test.mjs');
  if (!existsSync(installerTest)) throw new Error('shared installer verification dependencies are missing');
  const processTests = globSync(['tests/*.process.test.mjs', 'runtime/*/tests/*.process.test.mjs',
    'actions/*/tests/composite-execution.test.mjs'], { cwd: root }).sort().map((file) => path.join(root, file));
  return [...(processTests.length ? [{
    command: nodePath,
    args: [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', path.join(root, 'vitest.config.mjs'), ...processTests],
    cwd: root,
    action: 'process-boundary-contracts',
    phase: 'test',
  }] : []), {
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

export const batchTestVerificationPlan = (plan, root, reportPath) => {
  const testSteps = plan.filter((step) => step.phase === 'test');
  const tests = [...new Set(testSteps.flatMap((step) => step.args.slice(4)))];
  assert(tests.length > 0, 'source verification must include tests');
  return [...plan.filter((step) => step.phase !== 'test'), {
    command: testSteps[0].command,
    args: [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', path.join(root, 'vitest.config.mjs'), ...tests,
      '--reporter=default', '--reporter=json', '--outputFile=' + reportPath],
    cwd: root,
    action: 'bundled-actions-and-shared-runtime',
    phase: 'test',
    tests,
    reportPath,
  }];
};

export const assertVerificationReport = (report, tests) => {
  const result = classifyVitestReport(report);
  assert(report?.success === true && result.status === 'passed' && result.collection === 'complete', 'source tests did not produce a complete successful report');
  assert(result.counts.todo === 0, 'source tests must not be todo');
  const suites = report.testResults;
  assert(Array.isArray(suites), 'source test file results are missing');
  assert.deepEqual(suites.map((suite) => path.resolve(suite.name)).sort(), tests.map((file) => path.resolve(file)).sort(), 'source test file inventory differs from the verification plan');
  for (const suite of suites) {
    // Preserve capability-conditional cases while rejecting an entirely unexecuted file.
    assert(suite.status === 'passed' && suite.assertionResults.some((test) => test.status === 'passed'), 'source test file did not execute successfully: ' + suite.name);
  }
};

export const runVerificationPlan = (plan, execute = execFileSync, diagnostic = new FailureContext('repository-action-distribution', 'source-verification')) => {
  for (const [index, step] of plan.entries()) {
    diagnostic.at(step.phase, { action: step.action, input: 'action-source-and-contract-tests', completedSteps: index, remainingSteps: plan.length - index });
    try { process.stdout.write(`::group::${step.action} / ${step.phase}\n`); } catch { /* Group markers cannot mask the verification result. */ }
    try {
      diagnostic.writeState = 'verification-local-artifacts-possible';
      execute(step.command, step.args, { cwd: step.cwd, stdio: 'inherit' });
      if (step.reportPath) {
        const report = parseVitestReport(readFileSync(step.reportPath, 'utf8'));
        try { assertVerificationReport(report, step.tests); }
        catch (error) {
          throw new DiagnosticError('Action source test report is invalid', { diagnosticCode: 'action-source-test-report-invalid', cause: error,
            diagnostics: { field: 'source-test-report', expected: 'complete-planned-file-results', file: path.relative(step.cwd, step.reportPath) } });
        }
      }
      diagnostic.confirmed();
    } catch (error) {
      throw new DiagnosticError('Action source verification failed', {
        diagnosticCode: 'action-source-verification-failed', cause: error,
        diagnostics: { field: step.action, expected: 'zero-exit', ...(error instanceof DiagnosticError ? error.details : {}), observed: typeof error?.status === 'number' ? error.status : safeErrorReason(error), completedSteps: index, remainingSteps: plan.length - index },
      });
    } finally {
      try { process.stdout.write('::endgroup::\n'); } catch { /* Preserve a child failure when closing the log group fails. */ }
    }
  }
};

export const selectVerificationScope = (plan, scope = 'all') => {
  assert(['all', 'actions'].includes(scope), 'source-verification-scope-invalid');
  return scope === 'all' ? plan : plan.filter((step) => step.action !== 'shared-installer');
};

export const verifyActionPackages = (root = defaultRoot, diagnostic = new FailureContext('repository-action-distribution', 'source-verification'), { scope = 'all' } = {}) => {
  selectVerificationScope([], scope);
  diagnostic.at('action-inventory', { input: 'actions-and-package-metadata' });
  const packages = collectActionPackages(root);
  diagnostic.confirmed();
  diagnostic.at('runtime-boundaries', { input: 'action-import-dependencies', actionCount: packages.length });
  assertRuntimeBoundaries(root, packages);
  diagnostic.confirmed();
  diagnostic.at('verification-plan', { input: 'source-typechecks-and-contract-tests' });
  const originalPlan = [
    ...verificationPlan(packages),
    ...cliTypecheckPlan(root, packages),
    ...sharedRuntimeVerificationPlan(root),
  ];
  const outputRoot = path.join(root, 'tests/tmp/source-verification');
  mkdirSync(outputRoot, { recursive: true });
  const reportPath = path.join(mkdtempSync(path.join(outputRoot, 'run-')), 'test-results.json');
  const plan = batchTestVerificationPlan(batchActionTypecheckPlan(selectVerificationScope(originalPlan, scope), packages), root, reportPath);
  diagnostic.confirmed();
  runVerificationPlan(plan, execFileSync, diagnostic);
  diagnostic.at('result-output', { output: 'stdout-verification-result' });
  process.stdout.write(`Action source verification passed (${packages.length} bundled Actions).\n`);
};

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const diagnostic = new FailureContext('repository-action-distribution', 'source-verification');
  try {
    const args = process.argv.slice(2);
    assert(args.length === 0 || (args.length === 1 && args[0] === '--scope=actions'), 'source-verification-arguments-invalid');
    verifyActionPackages(defaultRoot, diagnostic, { scope: args.length ? 'actions' : 'all' });
  } catch (error) {
    process.exitCode = 1;
    const reason = diagnostic.report(error);
    completeFailure(reason, 1);
  }
}
