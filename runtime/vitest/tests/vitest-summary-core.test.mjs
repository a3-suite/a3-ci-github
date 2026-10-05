import { test, describe, expect } from 'vitest';

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

describe("vitest-summary-core", () => {
  test('classifies a complete report as passed with complete collection', () => {
    const result = classification({
      numTotalTests: 2,
      numPassedTests: 2,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      success: true,
    });
    expect(result).toStrictEqual({
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
    expect(result.counts).toStrictEqual({ total: 4, passed: 1, failed: 1, skipped: 1, todo: 1 });
    expect(result.status).toBe('failed');
    expect(result.collection).toBe('complete');
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
    expect(result.status).toBe('unresolved');
    expect(result.collection).toBe('partial');
    expect(result.diagnostics).toStrictEqual(['vitest-report-structure-invalid', 'vitest-report-counts-contradictory']);
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
    expect(result.status).toBe('unresolved');
    expect(result.collection).toBe('partial');
    expect(result.diagnostics).toStrictEqual(['vitest-report-counts-contradictory']);
  });

  test('keeps a partial count as partial collection', () => {
    const result = classification({ numTotalTests: 2 });
    expect(result.status).toBe('unresolved');
    expect(result.collection).toBe('partial');
    expect(result.diagnostics).toStrictEqual(['vitest-report-counts-inconsistent']);
  });

  test('rejects unknown assertion statuses', () => {
    const result = classification({
      testResults: [{ assertionResults: [{ status: 'mystery' }] }],
    });
    expect(result.status).toBe('unresolved');
    expect(result.collection).toBe('partial');
    expect(result.diagnostics).toStrictEqual(['vitest-report-structure-invalid', 'vitest-report-counts-inconsistent']);
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
    expect(result.status).toBe('failed');
    expect(result.collection).toBe('partial');
    expect(result.diagnostics).toStrictEqual(['vitest-report-explicit-failure', 'vitest-report-counts-contradictory']);
  });

  test('treats zero tests as unresolved instead of a false success', () => {
    expect(classification({ numTotalTests: 0, numPassedTests: 0, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, success: true })).toStrictEqual({
      status: 'unresolved',
      collection: 'unavailable',
      counts: { total: 0, passed: 0, failed: 0, skipped: 0, todo: 0 },
      diagnostics: ['vitest-report-empty'],
    });
    expect(classification({})).toStrictEqual({
      status: 'unresolved',
      collection: 'unavailable',
      counts: { total: null, passed: null, failed: null, skipped: null, todo: null },
      diagnostics: ['vitest-report-counts-inconsistent'],
    });
    expect(classification({ testResults: {} })).toStrictEqual({
      status: 'unresolved',
      collection: 'unavailable',
      counts: { total: null, passed: null, failed: null, skipped: null, todo: null },
      diagnostics: ['vitest-report-structure-invalid', 'vitest-report-counts-inconsistent'],
    });
    expect(classification({ testResults: [] })).toStrictEqual({
      status: 'unresolved',
      collection: 'unavailable',
      counts: { total: 0, passed: 0, failed: 0, skipped: 0, todo: 0 },
      diagnostics: ['vitest-report-empty'],
    });
  });

  test('rejects missing and malformed reports', () => {
    expect(classification(null)).toStrictEqual({
      status: 'unresolved',
      collection: 'unavailable',
      counts: { total: null, passed: null, failed: null, skipped: null, todo: null },
      diagnostics: ['vitest-report-missing'],
    });
    expect(classification([1, 2])).toStrictEqual({
      status: 'unresolved',
      collection: 'unavailable',
      counts: { total: null, passed: null, failed: null, skipped: null, todo: null },
      diagnostics: ['vitest-report-missing'],
    });
  });

  test('rejects malformed report elements with inconsistent counts', () => {
    const result = classification({ testResults: [null, 'invalid'] });
    expect(result.status).toBe('unresolved');
    expect(result.collection).toBe('partial');
    expect(result.diagnostics).toStrictEqual(['vitest-report-structure-invalid']);
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
    expect(result.counts.skipped).toBe(1);
  });

  test('parses JSON reports and rejects non-object values', () => {
    expect(parseVitestReport('{"success":true}')).toStrictEqual({ success: true });
    expect(parseVitestReport('[]')).toBe(null);
    expect(parseVitestReport('not-json')).toBe(null);
  });
});
