import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testRoot, '../../..');
const runtimeRoot = path.resolve(
  process.env.CI_GITHUB_PREFLIGHT_RUNTIME_ROOT ?? path.join(repositoryRoot, 'runtime/preset'),
);
const tsxPath = path.join(runtimeRoot, 'node_modules/.bin/tsx');
const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'a3-vitest-conformance-'));
after(() => {
  rmSync(temporaryRoot, { recursive: true, force: true });
  assert.equal(existsSync(temporaryRoot), false);
});

const outputValue = (raw, name) => {
  const match = raw.match(new RegExp(`${name}<<[^\\n]+\\n([\\s\\S]*?)\\n[^\\n]+`));
  return match ? match[1] : undefined;
};

let counter = 0;
const runAction = (reportPath) => {
  const outputPath = path.join(temporaryRoot, `action-output-${counter++}`);
  writeFileSync(outputPath, '');
  const result = spawnSync(process.execPath, [path.join(repositoryRoot, 'actions/ci-vitest-summary/dist/index.js')], {
    cwd: repositoryRoot,
    env: { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: outputPath, 'INPUT_REPORT-JSON': reportPath, 'INPUT_LABEL': 'unit' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const outputs = readFileSync(outputPath, 'utf8');
  return { status: outputValue(outputs, 'status'), collection: outputValue(outputs, 'collection') };
};

const runCli = (reportPath) => {
  const result = spawnSync(tsxPath, [path.join(repositoryRoot, 'runtime/adapter/vitest-test-summary.ts'), '--log', reportPath], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return {
    outcome: result.stdout.match(/^- 判定: (成功|失敗|判定不能)$/m)?.[1],
    collection: result.stdout.match(/^- 収集: (完了|一部取得|取得不可)$/m)?.[1],
  };
};

const outcomes = { passed: '成功', failed: '失敗', unresolved: '判定不能' };
const collections = { complete: '完了', partial: '一部取得', unavailable: '取得不可' };

const cases = [
  {
    title: 'Action and CLI agree on complete-pass',
    report: { numTotalTests: 2, numPassedTests: 2, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, success: true },
    status: 'passed',
    collection: 'complete',
  },
  {
    title: 'Action and CLI agree on explicit-failure',
    report: { numTotalTests: 1, numPassedTests: 0, numFailedTests: 1, numPendingTests: 0, numTodoTests: 0, success: false },
    status: 'failed',
    collection: 'complete',
  },
  {
    title: 'Action and CLI agree on assertion-malformation',
    report: { numTotalTests: 2, numPassedTests: 2, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, success: true, testResults: [{ assertionResults: [null] }] },
    status: 'unresolved',
    collection: 'partial',
  },
  {
    title: 'Action and CLI agree on unknown-status',
    report: { numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, success: true, testResults: [{ assertionResults: [{ status: 'mystery' }] }] },
    status: 'unresolved',
    collection: 'partial',
  },
  {
    title: 'Action and CLI agree on zero-tests',
    report: { numTotalTests: 0, numPassedTests: 0, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, success: true },
    status: 'unresolved',
    collection: 'unavailable',
  },
  {
    title: 'Action and CLI agree on derived-counts',
    report: { testResults: [{ assertionResults: [{ status: 'passed' }, { status: 'passed' }] }] },
    status: 'passed',
    collection: 'complete',
  },
  {
    title: 'Action and CLI agree on malformed-elements',
    report: { testResults: [null, 'invalid'] },
    status: 'unresolved',
    collection: 'partial',
  },
  {
    title: 'Action and CLI agree on invalid provided counts',
    report: { numFailedTests: -1, testResults: [{ assertionResults: [{ status: 'passed' }] }] },
    status: 'unresolved',
    collection: 'partial',
  },
  {
    title: 'Action and CLI agree on failure-with-malformation',
    report: { numTotalTests: 1, numPassedTests: 0, numFailedTests: 1, numPendingTests: 0, numTodoTests: 0, success: false, testResults: [{ assertionResults: [null] }] },
    status: 'failed',
    collection: 'partial',
  },
  {
    title: 'Action and CLI agree on summary-detail-contradiction',
    report: { numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, success: true, testResults: [{ assertionResults: [{ status: 'failed' }] }] },
    status: 'unresolved',
    collection: 'partial',
  },
  {
    title: 'Action and CLI agree on partial-counts',
    report: { numTotalTests: 2 },
    status: 'unresolved',
    collection: 'partial',
  },
];

for (const testCase of cases) {
  test(testCase.title, () => {
    const reportPath = path.join(temporaryRoot, `${testCase.name}.json`);
    writeFileSync(reportPath, JSON.stringify(testCase.report));
    const action = runAction(reportPath);
    const cli = runCli(reportPath);
    assert.deepEqual(action, { status: testCase.status, collection: testCase.collection });
    assert.deepEqual(cli, {
      outcome: outcomes[testCase.status],
      collection: collections[testCase.collection],
    });
  });
}
