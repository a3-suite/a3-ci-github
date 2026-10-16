import { test, describe, expect } from 'vitest';

import { classifyVitestReport, parseVitestReport } from '../vitest-report-core.mjs';

const classification = (report) => {
  const result = classifyVitestReport(report);
  return {
    status: result.status,
    collection: result.collection,
    counts: result.counts,
  };
};

describe("vitest-report-core", () => {
  // evidence_role: supplemental
  // test_level: unit
  // target_id: classifyVitestReport(report)
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
    });
  });

  // evidence_role: supplemental
  // test_level: unit
  // target_id: classifyVitestReport(report)
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

  // evidence_role: supplemental
  // test_level: unit
  // target_id: classifyVitestReport(report)
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
  });

  // evidence_role: supplemental
  // test_level: unit
  // target_id: classifyVitestReport(report)
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
  });

  // evidence_role: supplemental
  // test_level: unit
  // target_id: classifyVitestReport(report)
  test('keeps a partial count as partial collection', () => {
    const result = classification({ numTotalTests: 2 });
    expect(result.status).toBe('unresolved');
    expect(result.collection).toBe('partial');
  });

  // evidence_role: supplemental
  // test_level: unit
  // target_id: classifyVitestReport(report)
  test('rejects unknown assertion statuses', () => {
    const result = classification({
      testResults: [{ assertionResults: [{ status: 'mystery' }] }],
    });
    expect(result.status).toBe('unresolved');
    expect(result.collection).toBe('partial');
  });

  // evidence_role: supplemental
  // test_level: unit
  // target_id: classifyVitestReport(report)
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
  });

  // evidence_role: supplemental
  // test_level: unit
  // target_id: classifyVitestReport(report)
  test('treats zero tests as unresolved instead of a false success', () => {
    expect(classification({ numTotalTests: 0, numPassedTests: 0, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, success: true })).toStrictEqual({
      status: 'unresolved',
      collection: 'unavailable',
      counts: { total: 0, passed: 0, failed: 0, skipped: 0, todo: 0 },
    });
    expect(classification({})).toStrictEqual({
      status: 'unresolved',
      collection: 'unavailable',
      counts: { total: null, passed: null, failed: null, skipped: null, todo: null },
    });
    expect(classification({ testResults: {} })).toStrictEqual({
      status: 'unresolved',
      collection: 'unavailable',
      counts: { total: null, passed: null, failed: null, skipped: null, todo: null },
    });
    expect(classification({ testResults: [] })).toStrictEqual({
      status: 'unresolved',
      collection: 'unavailable',
      counts: { total: 0, passed: 0, failed: 0, skipped: 0, todo: 0 },
    });
  });

  // evidence_role: supplemental
  // test_level: unit
  // target_id: classifyVitestReport(report)
  test('rejects missing and malformed reports', () => {
    expect(classification(null)).toStrictEqual({
      status: 'unresolved',
      collection: 'unavailable',
      counts: { total: null, passed: null, failed: null, skipped: null, todo: null },
    });
    expect(classification([1, 2])).toStrictEqual({
      status: 'unresolved',
      collection: 'unavailable',
      counts: { total: null, passed: null, failed: null, skipped: null, todo: null },
    });
  });

  // evidence_role: supplemental
  // test_level: unit
  // target_id: classifyVitestReport(report)
  test('rejects malformed report elements with inconsistent counts', () => {
    const result = classification({ testResults: [null, 'invalid'] });
    expect(result.status).toBe('unresolved');
    expect(result.collection).toBe('partial');
  });

  // evidence_role: supplemental
  // test_level: unit
  // target_id: classifyVitestReport(report)
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

  // evidence_role: supplemental
  // test_level: unit
  // target_id: parseVitestReport(text)
  test('parses JSON reports and rejects non-object values', () => {
    expect(parseVitestReport('{"success":true}')).toStrictEqual({ success: true });
    expect(parseVitestReport('[]')).toBe(null);
    expect(parseVitestReport('not-json')).toBe(null);
  });
});
