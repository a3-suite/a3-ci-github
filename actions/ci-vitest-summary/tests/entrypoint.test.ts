import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
const root = path.resolve(__dirname, '..');
const outputValue = (raw: string, name: string): string => { const match = raw.match(new RegExp(`${name}<<[^\\n]+\\n([\\s\\S]*?)\\n[^\\n]+`)); assert.ok(match); return match[1]; };
// contract_id: contract.ci.vitest-summary.outputs
// integration_id: ci-vitest-summary-contract-entrypoint
test('bundled entrypoint writes a Vitest summary', () => {
  // Arrange
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-vitest-summary-')); const report = path.join(temp, 'report.json'); const summary = path.join(temp, 'summary.md'); const output = path.join(temp, 'outputs');
  fs.writeFileSync(report, JSON.stringify({ numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, success: true })); fs.writeFileSync(output, '');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output, 'INPUT_REPORT-JSON': report, 'INPUT_LABEL': 'unit', 'INPUT_SUMMARY-PATH': summary };
  // Act
  const result = spawnSync(process.execPath, [path.join(root, 'dist/index.js')], { cwd: root, env, encoding: 'utf8' });
  // Assert
  try { assert.equal(result.status, 0, result.stderr); assert.equal(outputValue(fs.readFileSync(output, 'utf8'), 'status'), 'passed'); assert.match(fs.readFileSync(summary, 'utf8'), /unit テスト結果/); } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

// integration_id: ci-vitest-summary-entrypoint-regression
test('bundled entrypoint keeps malformed report shapes unresolved', () => {
  // Arrange
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-vitest-summary-malformed-')); const report = path.join(temp, 'report.json'); const output = path.join(temp, 'outputs');
  fs.writeFileSync(report, JSON.stringify({ testResults: {} })); fs.writeFileSync(output, '');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output, 'INPUT_REPORT-JSON': report };
  // Act
  const result = spawnSync(process.execPath, [path.join(root, 'dist/index.js')], { cwd: root, env, encoding: 'utf8' });
  // Assert
  try { assert.equal(result.status, 0, result.stderr); assert.equal(outputValue(fs.readFileSync(output, 'utf8'), 'status'), 'unresolved'); } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

// integration_id: ci-vitest-summary-entrypoint-regression
test('bundled entrypoint keeps malformed report elements unresolved', () => {
  // Arrange
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-vitest-summary-malformed-element-')); const report = path.join(temp, 'report.json'); const output = path.join(temp, 'outputs');
  fs.writeFileSync(report, JSON.stringify({ testResults: [null, 'invalid'] })); fs.writeFileSync(output, '');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output, 'INPUT_REPORT-JSON': report };
  // Act
  const result = spawnSync(process.execPath, [path.join(root, 'dist/index.js')], { cwd: root, env, encoding: 'utf8' });
  // Assert
  try { assert.equal(result.status, 0, result.stderr); assert.equal(outputValue(fs.readFileSync(output, 'utf8'), 'status'), 'unresolved'); } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
