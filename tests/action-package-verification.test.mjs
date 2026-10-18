import path from 'node:path';
import fs from 'node:fs';
import { test, describe, expect } from 'vitest';
import * as sourceVerification from '../runtime/repository/verify-action-packages.mjs';
import { collectActions } from '../runtime/repository/check-action-dist.mjs';
import { collectActionPackages, runVerificationPlan, sharedRuntimeVerificationPlan, verificationPlan } from '../runtime/repository/verify-action-packages.mjs';
import { root } from "./action-package-verification.fixtures.mjs";

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
      expect(plan.find((step) => step.action === 'process-boundary-contracts').args)
        .toContain(path.join(root, 'tests/workflow-contracts.process.test.mjs'));
      expect(plan.filter((step) => step.action !== 'process-boundary-contracts')).toStrictEqual([{
        command: '/node',
        args: [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', path.join(root, 'vitest.config.mjs'), path.join(root, 'runtime/provisioner/tests/provision-core.test.ts')],
        cwd: path.join(root, 'actions/ci-gh-provisioner'),
        action: 'shared-provisioner-core',
        phase: 'test',
      }, {
        command: '/node',
        args: [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', path.join(root, 'vitest.config.mjs'), ...['assembly.test.mjs', 'observation.test.mjs', 'schema.test.ts', 'publisher.test.mjs', 'notes-binding.test.ts', 'skill-zip.test.ts'].map((file) => path.join(root, 'runtime/release-publication/tests', file))],
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
    // test_level: integration
    // integration_id: repository-source-verification-partition
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
