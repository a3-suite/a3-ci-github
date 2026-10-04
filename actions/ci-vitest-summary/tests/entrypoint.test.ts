import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, test, expect } from 'vitest';
import { actionEntrypointArguments } from '../../../tests/support/action-entrypoint';

describe.each(['source', 'dist'] as const)('%s entrypoint', (surface) => {
  const entrypointArgs = actionEntrypointArguments(path.resolve(__dirname, '..'), surface);
const root = path.resolve(__dirname, '..');
const outputValue = (raw: string, name: string): string => { const match = raw.match(new RegExp(`${name}<<[^\\n]+\\n([\\s\\S]*?)\\n[^\\n]+`)); expect(match).toBeTruthy(); return match![1]; };
// contract_id: contract.ci.vitest-summary.outputs
// integration_id: ci-vitest-summary-contract-entrypoint
test('entrypoint writes a Vitest summary', () => {
  // Arrange
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-vitest-summary-')); const report = path.join(temp, 'report.json'); const summary = path.join(temp, 'summary.md'); const output = path.join(temp, 'outputs');
  fs.writeFileSync(report, JSON.stringify({ numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, success: true })); fs.writeFileSync(output, '');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output, 'INPUT_REPORT-JSON': report, 'INPUT_LABEL': 'unit', 'INPUT_SUMMARY-PATH': summary };
  // Act
  const result = spawnSync(process.execPath, [...entrypointArgs], { cwd: root, env, encoding: 'utf8' });
  // Assert
  try {
    expect(result.status, result.stderr).toBe(0);
    const outputs = fs.readFileSync(output, 'utf8');
    expect(outputValue(outputs, 'status')).toBe('passed');
    expect(outputValue(outputs, 'collection')).toBe('complete');
    const markdown = fs.readFileSync(summary, 'utf8');
    expect(markdown).toMatch(/unit テスト結果/);
    expect(outputValue(outputs, 'digest')).toBe(`sha256:${createHash('sha256').update(markdown, 'utf8').digest('hex')}`);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

// integration_id: ci-vitest-summary-entrypoint-regression
test('entrypoint rejects a summary path that aliases the input report without modifying it', () => {
  // Arrange
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-vitest-summary-output-collision-')); const report = path.join(temp, 'report.json'); const output = path.join(temp, 'outputs');
  const original = JSON.stringify({ numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, success: true });
  fs.writeFileSync(report, original); fs.writeFileSync(output, '');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output, 'INPUT_REPORT-JSON': report, 'INPUT_SUMMARY-PATH': report };
  // Act
  const result = spawnSync(process.execPath, [...entrypointArgs], { cwd: root, env, encoding: 'utf8' });
  // Assert
  try {
    expect(result.status).not.toBe(0);
    expect(outputValue(fs.readFileSync(output, 'utf8'), 'status')).toBe('failed');
    expect(fs.readFileSync(report, 'utf8')).toBe(original);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

// integration_id: ci-vitest-summary-entrypoint-regression
test('entrypoint keeps malformed report shapes unresolved', () => {
  // Arrange
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-vitest-summary-malformed-')); const report = path.join(temp, 'report.json'); const output = path.join(temp, 'outputs');
  fs.writeFileSync(report, JSON.stringify({ testResults: {} })); fs.writeFileSync(output, '');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output, 'INPUT_REPORT-JSON': report };
  // Act
  const result = spawnSync(process.execPath, [...entrypointArgs], { cwd: root, env, encoding: 'utf8' });
  // Assert
  try { expect(result.status, result.stderr).toBe(0); expect(outputValue(fs.readFileSync(output, 'utf8'), 'status')).toBe('unresolved'); } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

// integration_id: ci-vitest-summary-entrypoint-regression
test('entrypoint keeps assertion-level malformation unresolved', () => {
  // Arrange
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-vitest-summary-malformed-assertion-')); const report = path.join(temp, 'report.json'); const output = path.join(temp, 'outputs');
  fs.writeFileSync(report, JSON.stringify({ numTotalTests: 2, numPassedTests: 2, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, success: true, testResults: [{ assertionResults: [null] }] })); fs.writeFileSync(output, '');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output, 'INPUT_REPORT-JSON': report };
  // Act
  const result = spawnSync(process.execPath, [...entrypointArgs], { cwd: root, env, encoding: 'utf8' });
  // Assert
  try { expect(result.status, result.stderr).toBe(0); expect(outputValue(fs.readFileSync(output, 'utf8'), 'status')).toBe('unresolved'); } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

// integration_id: ci-vitest-summary-entrypoint-regression
test('entrypoint keeps malformed report elements unresolved', () => {
  // Arrange
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-vitest-summary-malformed-element-')); const report = path.join(temp, 'report.json'); const output = path.join(temp, 'outputs');
  fs.writeFileSync(report, JSON.stringify({ testResults: [null, 'invalid'] })); fs.writeFileSync(output, '');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output, 'INPUT_REPORT-JSON': report };
  // Act
  const result = spawnSync(process.execPath, [...entrypointArgs], { cwd: root, env, encoding: 'utf8' });
  // Assert
  try { expect(result.status, result.stderr).toBe(0); expect(outputValue(fs.readFileSync(output, 'utf8'), 'status')).toBe('unresolved'); } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

});
