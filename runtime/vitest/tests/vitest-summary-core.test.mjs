import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyVitestReport, parseVitestReport } from '../vitest-summary-core.mjs';

const classification = (report) => {
  const result = classifyVitestReport(report);
  return {
    status: result.status,
    collection: result.collection,
    counts: result.counts,
    diagnostics: result.diagnostics.map((diagnostic) => diagnostic.code),
  };
};

test('classifies a complete report as passed with complete collection', () => {
  const result = classification({
    numTotalTests: 2,
    numPassedTests: 2,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    success: true,
  });
  assert.deepEqual(result, {
    status: 'passed',
    collection: 'complete',
    counts: { total: 2, passed: 2, failed: 0, skipped: 0, todo: 0 },
    diagnostics: [],
  });
});

test('derives counts from valid test results when counts are missing', () => {
  const result = classification({
    testResults: [
      { assertionResults: [{ status: 'passed' }, { status: 'failed' }, { status: 'pending' }, { status: 'todo' }] },
    ],
  });
  assert.deepEqual(result.counts, { total: 4, passed: 1, failed: 1, skipped: 1, todo: 1 });
  assert.equal(result.status, 'failed');
  assert.equal(result.collection, 'complete');
});

test('rejects assertion-level malformation even with complete counts', () => {
  const result = classification({
    numTotalTests: 2,
    numPassedTests: 2,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    success: true,
    testResults: [{ assertionResults: [null] }],
  });
  assert.equal(result.status, 'unresolved');
  assert.equal(result.collection, 'partial');
  assert.deepEqual(result.diagnostics, ['vitest-report-structure-invalid', 'vitest-report-counts-contradictory']);
});

test('does not let summary counts hide a detail-level failure', () => {
  const result = classification({
    numTotalTests: 1,
    numPassedTests: 1,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    success: true,
    testResults: [{ assertionResults: [{ status: 'failed' }] }],
  });
  assert.equal(result.status, 'unresolved');
  assert.equal(result.collection, 'partial');
  assert.deepEqual(result.diagnostics, ['vitest-report-counts-contradictory']);
});

test('keeps a partial count as partial collection', () => {
  const result = classification({ numTotalTests: 2 });
  assert.equal(result.status, 'unresolved');
  assert.equal(result.collection, 'partial');
  assert.deepEqual(result.diagnostics, ['vitest-report-counts-inconsistent']);
});

test('rejects unknown assertion statuses', () => {
  const result = classification({
    testResults: [{ assertionResults: [{ status: 'mystery' }] }],
  });
  assert.equal(result.status, 'unresolved');
  assert.equal(result.collection, 'partial');
  assert.deepEqual(result.diagnostics, ['vitest-report-structure-invalid', 'vitest-report-counts-inconsistent']);
});

test('keeps explicit failure precedence over malformed structure', () => {
  const result = classification({
    numTotalTests: 1,
    numPassedTests: 0,
    numFailedTests: 1,
    numPendingTests: 0,
    numTodoTests: 0,
    success: false,
    testResults: [{ assertionResults: [null] }],
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.collection, 'partial');
  assert.deepEqual(result.diagnostics, ['vitest-report-explicit-failure', 'vitest-report-counts-contradictory']);
});

test('treats zero tests as unresolved instead of a false success', () => {
  assert.deepEqual(classification({ numTotalTests: 0, numPassedTests: 0, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, success: true }), {
    status: 'unresolved',
    collection: 'unavailable',
    counts: { total: 0, passed: 0, failed: 0, skipped: 0, todo: 0 },
    diagnostics: ['vitest-report-empty'],
  });
  assert.deepEqual(classification({}), {
    status: 'unresolved',
    collection: 'unavailable',
    counts: { total: null, passed: null, failed: null, skipped: null, todo: null },
    diagnostics: ['vitest-report-counts-inconsistent'],
  });
  assert.deepEqual(classification({ testResults: {} }), {
    status: 'unresolved',
    collection: 'unavailable',
    counts: { total: null, passed: null, failed: null, skipped: null, todo: null },
    diagnostics: ['vitest-report-structure-invalid', 'vitest-report-counts-inconsistent'],
  });
  assert.deepEqual(classification({ testResults: [] }), {
    status: 'unresolved',
    collection: 'unavailable',
    counts: { total: 0, passed: 0, failed: 0, skipped: 0, todo: 0 },
    diagnostics: ['vitest-report-empty'],
  });
});

test('rejects missing and malformed reports', () => {
  assert.deepEqual(classification(null), {
    status: 'unresolved',
    collection: 'unavailable',
    counts: { total: null, passed: null, failed: null, skipped: null, todo: null },
    diagnostics: ['vitest-report-missing'],
  });
  assert.deepEqual(classification([1, 2]), {
    status: 'unresolved',
    collection: 'unavailable',
    counts: { total: null, passed: null, failed: null, skipped: null, todo: null },
    diagnostics: ['vitest-report-missing'],
  });
});

test('rejects malformed report elements with inconsistent counts', () => {
  const result = classification({ testResults: [null, 'invalid'] });
  assert.equal(result.status, 'unresolved');
  assert.equal(result.collection, 'partial');
  assert.deepEqual(result.diagnostics, ['vitest-report-structure-invalid']);
});

test('prefers pending over skipped as the alternative skipped count', () => {
  const result = classification({
    numTotalTests: 4,
    numPassedTests: 4,
    numFailedTests: 0,
    numPendingTests: 1,
    numSkippedTests: 3,
    numTodoTests: 0,
    success: true,
  });
  assert.equal(result.counts.skipped, 1);
});

test('parses JSON reports and rejects non-object values', () => {
  assert.deepEqual(parseVitestReport('{"success":true}'), { success: true });
  assert.equal(parseVitestReport('[]'), null);
  assert.equal(parseVitestReport('not-json'), null);
});
