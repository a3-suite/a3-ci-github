import { describe, test, expect } from 'vitest';
import { summarizeVitest } from '../src/summary.js';

describe('summarizeVitest(unknown,string,string)', () => {
  // target_id: summarizeVitest(unknown,string,string)
  test('summarizes a complete report', () => {
    // Arrange
    const report = { numTotalTests: 2, numPassedTests: 2, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, success: true };
    // Act
    const result = summarizeVitest(report, 'unit', 'vitest.json');
    // Assert
    expect(result.status).toBe('passed');
    expect(result.collection).toBe('complete');
    expect(result.markdown).toMatch(/2件/);
  });

  // target_id: summarizeVitest(unknown,string,string)
  test('keeps malformed reports unresolved without failing the step', () => {
    // Arrange
    const reports = [null, { testResults: {} as never }, { testResults: [null, 'invalid'] as never }];
    // Act
    const results = reports.map((report, index) => summarizeVitest(report, 'unit', `malformed-${index}.json`));
    // Assert
    expect(results.map((result) => [result.status, result.collection])).toStrictEqual([['unresolved', 'unavailable'], ['unresolved', 'unavailable'], ['unresolved', 'partial']]);
  });

  // target_id: summarizeVitest(unknown,string,string)
  test('rejects assertion-level malformation and unknown statuses with complete counts', () => {
    // Arrange
    const complete = { numTotalTests: 2, numPassedTests: 2, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, success: true };
    // Act
    const malformedAssertion = summarizeVitest({ ...complete, testResults: [{ assertionResults: [null] }] }, 'unit', 'vitest.json');
    const unknownStatus = summarizeVitest({ ...complete, testResults: [{ assertionResults: [{ status: 'mystery' }] }] }, 'unit', 'vitest.json');
    // Assert
    expect([malformedAssertion.status, malformedAssertion.collection]).toStrictEqual(['unresolved', 'partial']);
    expect(malformedAssertion.markdown).toMatch(/結果構造が不正/);
    expect([unknownStatus.status, unknownStatus.collection]).toStrictEqual(['unresolved', 'partial']);
  });

  // target_id: summarizeVitest(unknown,string,string)
  test('keeps invalid provided counts unresolved instead of deriving a false success', () => {
    // Arrange
    const reports = [
      { numFailedTests: -1, testResults: [{ assertionResults: [{ status: 'passed' }] }] },
      { numTotalTests: 1.5, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0 },
      { numTotalTests: '1', numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0 },
    ];
    // Act
    const results = reports.map((report) => summarizeVitest(report, 'unit', 'vitest.json'));
    // Assert
    expect(results.map((result) => result.status)).toStrictEqual(['unresolved', 'unresolved', 'unresolved']);
    for (const result of results) expect(result.markdown).toMatch(/集計値が不正/);
  });

  // target_id: summarizeVitest(unknown,string,string)
  test('keeps explicit failure precedence over malformed structure', () => {
    // Arrange
    const report = { numTotalTests: 1, numPassedTests: 0, numFailedTests: 1, numPendingTests: 0, numTodoTests: 0, success: false, testResults: [{ assertionResults: [null] }] };
    // Act
    const result = summarizeVitest(report, 'unit', 'vitest.json');
    // Assert
    expect(result.status).toBe('failed');
    expect(result.markdown).toMatch(/失敗を報告/);
  });

  // target_id: summarizeVitest(unknown,string,string)
  test('treats a zero-test report as unresolved instead of a false success', () => {
    // Arrange
    const report = { numTotalTests: 0, numPassedTests: 0, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, success: true };
    // Act
    const result = summarizeVitest(report, 'unit', 'vitest.json');
    // Assert
    expect([result.status, result.collection]).toStrictEqual(['unresolved', 'unavailable']);
    expect(result.markdown).toMatch(/テストが含まれていません/);
  });
});
