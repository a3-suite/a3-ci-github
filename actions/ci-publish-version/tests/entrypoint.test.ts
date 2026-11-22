import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, test, expect } from 'vitest';

import { actionEntrypointArguments } from '../../../tests/support/action-entrypoint';

describe.each(['source', 'dist'] as const)('%s entrypoint', (surface) => {
  const entrypointArgs = actionEntrypointArguments(path.resolve(__dirname, '..'), surface);
const root = path.resolve(__dirname, '..');

const runBundled = (plan: unknown, outputWritable = true, planText: string | null = JSON.stringify(plan), includePlanInput = true) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-publish-version-'));
  const planPath = path.join(tempRoot, 'version-plan.json');
  const outputPath = path.join(tempRoot, 'outputs');
  if (planText !== null) fs.writeFileSync(planPath, planText);
  fs.writeFileSync(outputPath, '', 'utf8');
  const env = {
    ...process.env,
    GITHUB_ACTIONS: 'true',
    GITHUB_OUTPUT: outputWritable ? outputPath : tempRoot,
    'INPUT_VERSION-PLAN-JSON': includePlanInput ? planPath : '',
  } as Record<string, string>;
  const result = spawnSync(process.execPath, [...entrypointArgs], { cwd: root, env, encoding: 'utf8' });
  const output = fs.readFileSync(outputPath, 'utf8');
  fs.rmSync(tempRoot, { recursive: true, force: true });
  return { result, output };
};

// flow_id: ci-publish-version-entrypoint-regression
test('entrypoint publishes a materialized version', () => {
  // Arrange
  // Act
  const run = runBundled({ strategy: 'ciGenerated', template: '{baseVersion}-dev.{build}', components: { baseVersion: '1.2.3', build: '42' } });
  // Assert
  expect(run.result.status).toBe(0);
  expect(run.output).toMatch(/^status<<([^\r\n]+)\r?\nsuccess\r?\n\1$/m);
  expect(run.output).toMatch(/^publish-version<<([^\r\n]+)\r?\n1\.2\.3-dev\.42\r?\n\1$/m);
});

// contract_id: contract.ci-publish-version.outputs
// flow_id: ci-publish-version-contract-entrypoint
test('entrypoint publishes an exact version', () => {
  // Arrange
  // Act
  const run = runBundled({ strategy: 'exact', publishVersion: '1.2.3' });
  // Assert
  expect(run.result.status).toBe(0);
  expect(run.output).toMatch(/^status<<([^\r\n]+)\r?\nsuccess\r?\n\1$/m);
  expect(run.output).toMatch(/^publish-version<<([^\r\n]+)\r?\n1\.2\.3\r?\n\1$/m);
});

// flow_id: ci-publish-version-entrypoint-regression
test('entrypoint fails invalid plan input', () => {
  // Arrange
  // Act
  const run = runBundled({ strategy: 'ciGenerated', template: '{baseVersion}', components: {} });
  // Assert
  expect(run.result.status).not.toBe(0);
  expect(run.result.stderr).toMatch(/^ci-failure-diagnostic:.*"stage":"template-expansion"/m);
  expect(run.output).toMatch(/status<<.*failed/s);
  expect(run.output).not.toMatch(/^publish-version(?:=|<<)/m);
});

// contract_id: contract.ci-publish-version.outputs
test('entrypoint rejects unreadable and malformed plan files', () => {
  for (const { planText, includePlanInput } of [
    { planText: null, includePlanInput: false },
    { planText: null, includePlanInput: true },
    { planText: '{', includePlanInput: true },
  ]) {
    const { result, output } = runBundled(null, true, planText, includePlanInput);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/^ci-failure-diagnostic:.*"stage":"plan-read"/m);
    expect(output).not.toMatch(/^publish-version(?:=|<<)/m);
  }
});

// contract_id: contract.ci-publish-version.outputs
test('entrypoint diagnoses failure to write the version output', () => {
  const { result } = runBundled({ strategy: 'exact', publishVersion: '1.2.3' }, false);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/^ci-failure-diagnostic:.*"stage":"output-write"/m);
});

});
