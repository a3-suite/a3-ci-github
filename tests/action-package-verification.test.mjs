import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test, describe, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import * as sourceVerification from '../runtime/repository/verify-action-packages.mjs';

import { collectActions } from '../runtime/repository/check-action-dist.mjs';
import {
  collectActionPackages,
  runVerificationPlan,
  sharedRuntimeVerificationPlan,
  verificationPlan,
} from '../runtime/repository/verify-action-packages.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('repository-cli-source-verification', () => {
  describe('cliTypecheckPlan', () => {
    // contract_id: contract.repository-action-distribution.integrity
    // test_level: integration
    // integration_id: repository-cli-source-verification
    test('the CLI verification plan accepts valid sources and rejects type errors in every CLI source family', (t) => {
      // Arrange
      const parent = path.join(root, 'tests/tmp');
      fs.mkdirSync(parent, { recursive: true });
      const fixtureRoot = fs.mkdtempSync(path.join(parent, 'cli-typecheck-'));
      t.onTestFinished(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
      for (const config of ['tsconfig.action.json', 'tsconfig.cli.json']) {
        fs.copyFileSync(path.join(root, config), path.join(fixtureRoot, config));
      }
      const sources = ['runtime/adapter/cli-runtime.ts', 'runtime/preset/validate-ci-preset.ts', 'runtime/distribution/generate-distribution-release.ts', 'runtime/installer/cli.ts'];
      for (const source of sources) {
        const filename = path.join(fixtureRoot, source);
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, 'export const value: string = "valid";\n');
      }
      const excluded = path.join(fixtureRoot, 'runtime/preset/tests/excluded.test.ts');
      fs.mkdirSync(path.dirname(excluded), { recursive: true });
      fs.writeFileSync(excluded, 'export const value: string = 7;\n');
      const step = sourceVerification.cliTypecheckPlan(fixtureRoot, collectActionPackages(root))[0];
      // Act
      const valid = spawnSync(step.command, step.args, { cwd: step.cwd, encoding: 'utf8' });
      for (const source of sources) fs.writeFileSync(path.join(fixtureRoot, source), 'export const value = (input) => input;\n');
      const invalid = spawnSync(step.command, step.args, { cwd: step.cwd, encoding: 'utf8' });
      // Assert
      expect(valid.status, valid.stdout + valid.stderr).toBe(0);
      expect(invalid.status).not.toBe(0);
      for (const source of sources) expect(invalid.stdout.replaceAll('\\', '/')).toContain(source);
      expect(invalid.stdout).toContain('TS7006');
      expect(step.args.some((argument) => argument === 'ci' || argument === 'build')).toBe(false);
    });
  });
});

describe("contract.repository-action-distribution.integrity", () => {
  describe("repository-action-source-verification", () => {
    // contract_id: contract.repository-action-distribution.integrity
    // integration_id: repository-action-source-verification
    test('retains the known report rejection reason after a zero child exit', (t) => {
      // Arrange
      const parent = path.join(root, 'tests/tmp');
      fs.mkdirSync(parent, { recursive: true });
      const directory = fs.mkdtempSync(path.join(parent, 'report-rejection-'));
      t.onTestFinished(() => fs.rmSync(directory, { recursive: true }));
      const reportPath = path.join(directory, 'test-results.json');
      fs.writeFileSync(reportPath, JSON.stringify({ success: true, testResults: [] }));
      const step = { command: '/node', args: [], cwd: root, action: 'bundled-actions-and-shared-runtime', phase: 'test', tests: [path.join(root, 'tests/missing.test.mjs')], reportPath };
      // Act
      let failure;
      try { runVerificationPlan([step], () => undefined); } catch (error) { failure = error; }
      // Assert
      expect(failure?.details).toMatchObject({ field: 'source-test-report', expected: 'complete-planned-file-results', observed: 'action-source-test-report-invalid', file: path.relative(root, reportPath) });
    });

    // contract_id: contract.repository-action-distribution.integrity
    // integration_id: repository-action-source-verification
    test('batched typechecks keep project globals isolated and reject errors after a previous successful build', (t) => {
      // Arrange
      const parent = path.join(root, 'tests/tmp');
      fs.mkdirSync(parent, { recursive: true });
      const fixture = fs.mkdtempSync(path.join(parent, 'batched-typecheck-'));
      t.onTestFinished(() => fs.rmSync(fixture, { recursive: true }));
      fs.copyFileSync(path.join(root, 'tsconfig.action.json'), path.join(fixture, 'tsconfig.action.json'));
      const dependencyRoot = path.join(collectActionPackages(root)[0].path, 'node_modules');
      const packages = ['alpha', 'beta'].map((name) => {
        const directory = path.join(fixture, 'actions', name);
        fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
        fs.symlinkSync(dependencyRoot, path.join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
        fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ scripts: { lint: 'tsc --noEmit' } }));
        fs.writeFileSync(path.join(directory, 'tsconfig.json'), JSON.stringify({ extends: '../../tsconfig.action.json', include: ['src/**/*.ts', 'tests/**/*.ts'] }));
        fs.writeFileSync(path.join(directory, 'src/global.ts'), 'const isolated: string = "valid";\n');
        return { name, path: directory, tests: [] };
      });
      // Act
      const plan = sourceVerification.batchActionTypecheckPlan(verificationPlan(packages), packages);
      const step = plan.find((entry) => entry.phase === 'typecheck');
      const valid = spawnSync(step.command, step.args, { cwd: step.cwd, encoding: 'utf8' });
      for (const entry of packages) fs.writeFileSync(path.join(entry.path, 'src/global.ts'), 'const isolated: string = 1;\n');
      const invalid = spawnSync(step.command, step.args, { cwd: step.cwd, encoding: 'utf8' });
      // Assert
      expect(plan.filter((entry) => entry.phase === 'typecheck')).toHaveLength(1);
      expect(valid.status, valid.stdout + valid.stderr).toBe(0);
      expect(invalid.status).not.toBe(0);
      for (const entry of packages) expect(invalid.stdout.replaceAll('\\', '/')).toContain('actions/' + entry.name + '/src/global.ts');
      expect(invalid.stdout).toContain('TS2322');
      expect(step.args).toContain('--force');
    });

    // contract_id: contract.repository-action-distribution.integrity
    // integration_id: repository-action-source-verification
    test('batches every Action and shared test once while retaining all typechecks', () => {
      // Arrange
      const packages = collectActionPackages(root);
      const original = [...verificationPlan(packages), ...sourceVerification.cliTypecheckPlan(root, packages), ...sharedRuntimeVerificationPlan(root)];
      const reportPath = path.join(root, 'tests/tmp/source-results.json');
      // Act
      const plan = sourceVerification.batchTestVerificationPlan(original, root, reportPath);
      // Assert
      expect(plan.filter((step) => step.phase === 'typecheck')).toStrictEqual(original.filter((step) => step.phase === 'typecheck'));
      const tests = plan.filter((step) => step.phase === 'test');
      expect(tests).toHaveLength(1);
      expect(tests[0].cwd).toBe(root);
      expect(tests[0].tests).toStrictEqual([...new Set(original.filter((step) => step.phase === 'test').flatMap((step) => step.args.slice(4)))]);
      expect(tests[0].args.slice(4, 4 + tests[0].tests.length)).toStrictEqual(tests[0].tests);
      expect(tests[0].args).toContain('--outputFile=' + reportPath);
    });

    // contract_id: contract.repository-action-distribution.integrity
    // integration_id: repository-action-source-verification
    test('rejects missing files, empty, entirely skipped and unknown test results despite a zero child exit', () => {
      // Arrange
      const files = ['/checkout/actions/alpha/tests/a.test.ts', '/checkout/runtime/core/tests/b.test.ts'];
      const report = { success: true, testResults: files.map((name) => ({ name, status: 'passed', assertionResults: [{ fullName: 'contract > succeeds', status: 'passed' }] })) };
      // Act / Assert
      expect(() => sourceVerification.assertVerificationReport(report, files)).not.toThrow();
      expect(() => sourceVerification.assertVerificationReport({ ...report, testResults: [{ ...report.testResults[0], assertionResults: [...report.testResults[0].assertionResults, { status: 'skipped' }] }, report.testResults[1]] }, files)).not.toThrow();
      expect(() => sourceVerification.assertVerificationReport({ ...report, testResults: report.testResults.slice(0, 1) }, files)).toThrow();
      for (const status of ['skipped', 'cancelled', 'todo', 'pending']) {
        expect(() => sourceVerification.assertVerificationReport({ ...report, testResults: [{ ...report.testResults[0], assertionResults: [{ status }] }, report.testResults[1]] }, files)).toThrow();
      }
      expect(() => sourceVerification.assertVerificationReport({ ...report, testResults: [{ ...report.testResults[0], assertionResults: [] }, report.testResults[1]] }, files)).toThrow();
      expect(() => sourceVerification.assertVerificationReport(null, files)).toThrow();
    });
    // contract_id: contract.repository-action-distribution.integrity
    // integration_id: repository-action-source-verification
    test('derives typecheck and no-rebuild test steps for every bundled Action', () => {
      // Arrange
      const bundledActions = collectActions(root).filter((action) => action.distPath);
      // Act
      const packages = collectActionPackages(root);
      const plan = verificationPlan(packages, '/node');
      // Assert
      expect(packages.map((entry) => entry.name).sort()).toStrictEqual(bundledActions.map((entry) => entry.name).sort());
      expect(packages.every((entry) => entry.tests.length > 0)).toBeTruthy();
      expect(plan.length).toBe(packages.length * 2);
      for (const entry of packages) {
        const steps = plan.filter((step) => step.action === entry.name);
        expect(new Set(steps.map((step) => step.phase))).toStrictEqual(new Set(['typecheck', 'test']));
        const typecheck = steps.find((step) => step.phase === 'typecheck');
        const testStep = steps.find((step) => step.phase === 'test');
        expect(typecheck.args).toStrictEqual(['run', 'lint']);
        expect(testStep.args).toStrictEqual([path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', path.join(root, 'vitest.config.mjs'), ...entry.tests.map((file) => path.join(entry.path, file))]);
        expect(steps.some((step) => step.args.includes('ci') || step.args.includes('build'))).toBe(false);
      }
    });

    // contract_id: contract.repository-action-distribution.integrity
    // integration_id: repository-action-source-verification
    test('the formal Action source gate rejects type errors independently of bundling', (t) => {
      const parent = path.join(root, 'tests/tmp');
      fs.mkdirSync(parent, { recursive: true });
      const fixture = fs.mkdtempSync(path.join(parent, 'action-typecheck-'));
      t.onTestFinished(() => fs.rmSync(fixture, { recursive: true, force: true }));
      const action = path.join(fixture, 'actions/example');
      fs.mkdirSync(path.join(action, 'node_modules/.bin'), { recursive: true });
      const compiler = path.join(collectActionPackages(root)[0].path, 'node_modules/typescript/bin/tsc');
      fs.symlinkSync(compiler, path.join(action, 'node_modules/.bin/tsc'));
      fs.writeFileSync(path.join(action, 'package.json'), JSON.stringify({ scripts: { lint: 'tsc --noEmit' } }));
      fs.writeFileSync(path.join(action, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, types: [] }, include: ['source.ts'] }));
      const source = path.join(action, 'source.ts');
      const step = verificationPlan([{ name: 'example', path: action, tests: [] }])[0];
      fs.writeFileSync(source, 'export const value: string = "valid";\n');
      const valid = spawnSync(step.command, step.args, { cwd: step.cwd, encoding: 'utf8' });
      fs.writeFileSync(source, 'export const value: string = 1;\n');
      const invalid = spawnSync(step.command, step.args, { cwd: step.cwd, encoding: 'utf8' });
      expect(valid.status, valid.stdout + valid.stderr).toBe(0);
      expect(invalid.status).not.toBe(0);
      expect(invalid.stdout).toContain('TS2322');
    });
  });
});

describe("action-package-verification", () => {
  describe("action-package-verification", () => {
    test('Action verification uses the selected checkout rather than the implementation checkout', () => {
      const selectedRoot = path.resolve('tests/tmp/selected-checkout');
      const actionRoot = path.join(selectedRoot, 'actions/example');
      const plan = verificationPlan([{ name: 'example', path: actionRoot, tests: ['tests/core.test.ts'] }], '/node');
      expect(plan[1].args).toStrictEqual([path.join(selectedRoot, 'node_modules/vitest/vitest.mjs'), 'run', '--config', path.join(selectedRoot, 'vitest.config.mjs'), path.join(actionRoot, 'tests/core.test.ts')]);
    });

    test('connects shared provisioner, publication and installer tests without another install or build', () => {
      const plan = sharedRuntimeVerificationPlan(root, '/node');
      expect(plan).toStrictEqual([{
        command: '/node',
        args: [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', path.join(root, 'vitest.config.mjs'), path.join(root, 'runtime/provisioner/tests/provision-core.test.ts')],
        cwd: path.join(root, 'actions/ci-gh-provisioner'),
        action: 'shared-provisioner-core',
        phase: 'test',
      }, {
        command: '/node',
        args: [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', path.join(root, 'vitest.config.mjs'), ...['assembly.test.mjs', 'observation.test.mjs', 'schema.test.ts', 'publisher.test.mjs', 'notes-binding.test.ts'].map((file) => path.join(root, 'runtime/release-publication/tests', file))],
        cwd: path.join(root, 'actions/ci-release-assembly'),
        action: 'shared-release-publication',
        phase: 'test',
      }, {
        command: '/node',
        args: [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', path.join(root, 'vitest.config.mjs'), path.join(root, 'runtime/installer/tests/common-regression.test.mjs')],
        cwd: root,
        action: 'shared-installer',
        phase: 'test',
      }]);
    });

    test('runs every planned verification step in order', () => {
      // Arrange
      const plan = [
        { command: 'first', args: ['a'], cwd: '/one', action: 'alpha', phase: 'typecheck' },
        { command: 'second', args: ['b'], cwd: '/two', action: 'alpha', phase: 'test' },
      ];
      const calls = [];
      // Act
      runVerificationPlan(plan, (command, args, options) => calls.push({ command, args, options }));
      // Assert
      expect(calls).toStrictEqual([
        { command: 'first', args: ['a'], options: { cwd: '/one', stdio: 'inherit' } },
        { command: 'second', args: ['b'], options: { cwd: '/two', stdio: 'inherit' } },
      ]);
    });
  });
});


describe('source verification CI partition', () => {
  describe('selectVerificationScope', () => {
    // evidence_role: supplemental
    // test_level: unit
    // target_id: selectVerificationScope
    test('partitions the complete plan without dropping or duplicating tests and keeps all as default', () => {
      // Arrange
      const packages = collectActionPackages(root);
      const complete = [...verificationPlan(packages), ...sourceVerification.cliTypecheckPlan(root, packages), ...sharedRuntimeVerificationPlan(root)];
      // Act
      const actions = sourceVerification.selectVerificationScope(complete, 'actions');
      const installer = complete.filter((step) => step.action === 'shared-installer');
      // Assert
      expect(sourceVerification.selectVerificationScope(complete)).toBe(complete);
      expect(installer).toHaveLength(1);
      expect(installer[0].args.slice(4)).toEqual([path.join(root, 'runtime/installer/tests/common-regression.test.mjs')]);
      expect(actions.length + installer.length).toBe(complete.length);
      expect(actions.some((step) => installer.includes(step))).toBe(false);
      expect(complete.every((step) => actions.includes(step) || installer.includes(step))).toBe(true);
      expect(() => sourceVerification.selectVerificationScope(complete, 'typo')).toThrow('source-verification-scope-invalid');
    });
  });
});
