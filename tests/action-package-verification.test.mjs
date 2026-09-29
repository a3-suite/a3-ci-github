import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { collectActions } from '../runtime/repository/check-action-dist.mjs';
import {
  collectActionPackages,
  runVerificationPlan,
  sharedRuntimeVerificationPlan,
  verificationPlan,
} from '../runtime/repository/verify-action-packages.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// contract_id: contract.repository-action-distribution.integrity
// integration_id: repository-action-source-verification
test('derives typecheck and no-rebuild test steps for every bundled Action', () => {
  // Arrange
  const bundledActions = collectActions(root).filter((action) => action.distPath);
  // Act
  const packages = collectActionPackages(root);
  const plan = verificationPlan(packages, '/node');
  // Assert
  assert.deepEqual(
    packages.map((entry) => entry.name).sort(),
    bundledActions.map((entry) => entry.name).sort(),
  );
  assert.ok(packages.every((entry) => entry.tests.length > 0));
  assert.equal(plan.length, packages.length * 2);
  for (const entry of packages) {
    const steps = plan.filter((step) => step.action === entry.name);
    assert.deepEqual(new Set(steps.map((step) => step.phase)), new Set(['typecheck', 'test']));
    const typecheck = steps.find((step) => step.phase === 'typecheck');
    const testStep = steps.find((step) => step.phase === 'test');
    assert.deepEqual(typecheck.args, ['run', 'lint']);
    assert.deepEqual(testStep.args, ['--import=tsx', '--test', ...entry.tests]);
    assert.equal(steps.some((step) => step.args.includes('ci') || step.args.includes('build')), false);
  }
});

test('connects shared provisioner core tests without another install or build', () => {
  const plan = sharedRuntimeVerificationPlan(root, '/node');
  assert.deepEqual(plan, [{
    command: '/node',
    args: ['--import=tsx', '--test', '../../runtime/provisioner/tests/provision-core.test.ts'],
    cwd: path.join(root, 'actions/ci-gh-provisioner'),
    action: 'shared-provisioner-core',
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
  assert.deepEqual(calls, [
    { command: 'first', args: ['a'], options: { cwd: '/one', stdio: 'inherit' } },
    { command: 'second', args: ['b'], options: { cwd: '/two', stdio: 'inherit' } },
  ]);
});
