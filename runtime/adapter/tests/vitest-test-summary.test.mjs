import assert from 'node:assert/strict';
import { afterAll as after, test } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'a3-vitest-test-summary-'));
after(() => {
  rmSync(temporaryRoot, { recursive: true, force: true });
  assert.equal(existsSync(temporaryRoot), false);
});

const writeReport = (name, value) => {
  const reportPath = path.join(temporaryRoot, name);
  writeFileSync(reportPath, typeof value === 'string' ? value : JSON.stringify(value));
  return reportPath;
};

const runCli = (args) => spawnSync(tsxPath, [path.join(repositoryRoot, 'runtime/adapter/vitest-test-summary.ts'), ...args], {
  cwd: repositoryRoot,
  encoding: 'utf8',
});

const cliOutcome = (markdown) => markdown.match(/^- 判定: (成功|失敗|判定不能)$/m)?.[1];
const cliCollection = (markdown) => markdown.match(/^- 収集: (完了|一部取得|取得不可)$/m)?.[1];

test('renders a complete report as success with complete collection', () => {
  const reportPath = writeReport('complete.json', {
    numTotalTests: 2,
    numPassedTests: 2,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    success: true,
  });
  const result = runCli(['--log', reportPath, '--name', 'unit']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(cliOutcome(result.stdout), '成功');
  assert.equal(cliCollection(result.stdout), '完了');
});

test('renders explicit failures and failed names', () => {
  const reportPath = writeReport('failed.json', {
    numTotalTests: 1,
    numPassedTests: 0,
    numFailedTests: 1,
    numPendingTests: 0,
    numTodoTests: 0,
    success: false,
    testResults: [{ assertionResults: [{ status: 'failed', fullName: 'suite rejects input' }] }],
  });
  const result = runCli(['--log', reportPath]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(cliOutcome(result.stdout), '失敗');
  assert.match(result.stdout, /suite rejects input/);
});

test('renders zero-test reports as indeterminate', () => {
  const reportPath = writeReport('zero.json', {
    numTotalTests: 0,
    numPassedTests: 0,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    success: true,
  });
  const result = runCli(['--log', reportPath]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(cliOutcome(result.stdout), '判定不能');
  assert.equal(cliCollection(result.stdout), '取得不可');
});

test('renders assertion-level malformation as indeterminate with partial collection', () => {
  const reportPath = writeReport('malformed.json', {
    numTotalTests: 2,
    numPassedTests: 2,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    success: true,
    testResults: [{ assertionResults: [null] }],
  });
  const result = runCli(['--log', reportPath]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(cliOutcome(result.stdout), '判定不能');
  assert.equal(cliCollection(result.stdout), '一部取得');
  assert.match(result.stdout, /結果構造が不正/);
});

test('renders a missing report as indeterminate', () => {
  const result = runCli(['--log', path.join(temporaryRoot, 'missing.json')]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(cliOutcome(result.stdout), '判定不能');
});

test('renders invalid JSON as indeterminate', () => {
  const reportPath = writeReport('invalid.json', 'not-json');
  const result = runCli(['--log', reportPath]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(cliOutcome(result.stdout), '判定不能');
});

test('renders the summary table and keeps detail values line-normalized', () => {
  const reportPath = writeReport('display.json', {
    numTotalTests: 1,
    numPassedTests: 0,
    numFailedTests: 1,
    numPendingTests: 0,
    numTodoTests: 0,
    success: false,
    testResults: [{ assertionResults: [{ status: 'failed', fullName: 'suite ng`case\nnext' }] }],
  });
  const result = runCli(['--log', reportPath]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^### テストサマリ$/m);
  assert.match(result.stdout, /^\| テスト \| 実施 \| 結果 \|$/m);
  assert.match(result.stdout, /^\|:--\|:--\|:--:\|$/m);
  assert.match(result.stdout, /^\| `テスト` \| テストレポートを解析 \| ❌ 失敗（1件） \|$/m);
  assert.match(result.stdout, /^- 判定: 失敗$/m);
  assert.match(result.stdout, /^- 収集: 完了$/m);
  const failedNameLine = result.stdout.split('\n').find((line) => line.includes('suite'));
  assert.ok(failedNameLine, result.stdout);
  assert.ok(failedNameLine.includes('next'), failedNameLine);
  assert.doesNotMatch(result.stdout, /\r/);

  const partialPath = writeReport('partial.json', { numTotalTests: 3 });
  const partial = runCli(['--log', partialPath]);
  assert.equal(partial.status, 0, partial.stderr);
  assert.match(partial.stdout, /^- テスト: 3件$/m);
  assert.doesNotMatch(partial.stdout, /- テスト: 3件（/);
});
