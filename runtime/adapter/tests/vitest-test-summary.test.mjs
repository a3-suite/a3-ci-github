import { afterAll as after, test, describe, expect } from 'vitest';
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
  expect(existsSync(temporaryRoot)).toBe(false);
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

describe("vitest-test-summary", () => {
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
    expect(result.status, result.stderr).toBe(0);
    expect(cliOutcome(result.stdout)).toBe('成功');
    expect(cliCollection(result.stdout)).toBe('完了');
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
    expect(result.status, result.stderr).toBe(0);
    expect(cliOutcome(result.stdout)).toBe('失敗');
    expect(result.stdout).toMatch(/suite rejects input/);
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
    expect(result.status, result.stderr).toBe(0);
    expect(cliOutcome(result.stdout)).toBe('判定不能');
    expect(cliCollection(result.stdout)).toBe('取得不可');
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
    expect(result.status, result.stderr).toBe(0);
    expect(cliOutcome(result.stdout)).toBe('判定不能');
    expect(cliCollection(result.stdout)).toBe('一部取得');
    expect(result.stdout).toMatch(/結果構造が不正/);
  });

  test('renders a missing report as indeterminate', () => {
    const result = runCli(['--log', path.join(temporaryRoot, 'missing.json')]);
    expect(result.status, result.stderr).toBe(0);
    expect(cliOutcome(result.stdout)).toBe('判定不能');
  });

  test('renders invalid JSON as indeterminate', () => {
    const reportPath = writeReport('invalid.json', 'not-json');
    const result = runCli(['--log', reportPath]);
    expect(result.status, result.stderr).toBe(0);
    expect(cliOutcome(result.stdout)).toBe('判定不能');
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
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^### テストサマリ$/m);
    expect(result.stdout).toMatch(/^\| テスト \| 実施 \| 結果 \|$/m);
    expect(result.stdout).toMatch(/^\|:--\|:--\|:--:\|$/m);
    expect(result.stdout).toMatch(/^\| `テスト` \| テストレポートを解析 \| ❌ 失敗（1件） \|$/m);
    expect(result.stdout).toMatch(/^- 判定: 失敗$/m);
    expect(result.stdout).toMatch(/^- 収集: 完了$/m);
    const failedNameLine = result.stdout.split('\n').find((line) => line.includes('suite'));
    expect(failedNameLine, result.stdout).toBeTruthy();
    expect(failedNameLine.includes('next'), failedNameLine).toBeTruthy();
    expect(result.stdout).not.toMatch(/\r/);

    const partialPath = writeReport('partial.json', { numTotalTests: 3 });
    const partial = runCli(['--log', partialPath]);
    expect(partial.status, partial.stderr).toBe(0);
    expect(partial.stdout).toMatch(/^- テスト: 3件$/m);
    expect(partial.stdout).not.toMatch(/- テスト: 3件（/);
  });
});
