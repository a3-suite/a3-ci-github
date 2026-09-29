import { strict as assert } from 'node:assert';
import test from 'node:test';
import { summarizeVitest } from '../src/summary.js';

// target_id: summarizeVitest(unknown,string,string)
test('summarizes a complete report', () => {
  // Arrange
  const report = { numTotalTests: 2, numPassedTests: 2, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, success: true };
  // Act
  const result = summarizeVitest(report, 'unit', 'vitest.json');
  // Assert
  assert.equal(result.status, 'passed');
  assert.equal(result.collection, 'complete');
  assert.match(result.markdown, /2件/);
});

// target_id: summarizeVitest(unknown,string,string)
test('keeps malformed reports unresolved without failing the step', () => {
  // Arrange
  const reports = [null, { testResults: {} as never }, { testResults: [null, 'invalid'] as never }];
  // Act
  const results = reports.map((report, index) => summarizeVitest(report, 'unit', `malformed-${index}.json`));
  // Assert
  assert.deepEqual(results.map((result) => [result.status, result.collection]), [['unresolved', 'unavailable'], ['unresolved', 'unavailable'], ['unresolved', 'partial']]);
});

// target_id: summarizeVitest(unknown,string,string)
test('rejects assertion-level malformation and unknown statuses with complete counts', () => {
  // Arrange
  const complete = { numTotalTests: 2, numPassedTests: 2, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, success: true };
  // Act
  const malformedAssertion = summarizeVitest({ ...complete, testResults: [{ assertionResults: [null] }] }, 'unit', 'vitest.json');
  const unknownStatus = summarizeVitest({ ...complete, testResults: [{ assertionResults: [{ status: 'mystery' }] }] }, 'unit', 'vitest.json');
  // Assert
  assert.deepEqual([malformedAssertion.status, malformedAssertion.collection], ['unresolved', 'partial']);
  assert.match(malformedAssertion.markdown, /結果構造が不正/);
  assert.deepEqual([unknownStatus.status, unknownStatus.collection], ['unresolved', 'partial']);
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
  assert.deepEqual(results.map((result) => result.status), ['unresolved', 'unresolved', 'unresolved']);
  for (const result of results) assert.match(result.markdown, /集計値が不正/);
});

// target_id: summarizeVitest(unknown,string,string)
test('keeps explicit failure precedence over malformed structure', () => {
  // Arrange
  const report = { numTotalTests: 1, numPassedTests: 0, numFailedTests: 1, numPendingTests: 0, numTodoTests: 0, success: false, testResults: [{ assertionResults: [null] }] };
  // Act
  const result = summarizeVitest(report, 'unit', 'vitest.json');
  // Assert
  assert.equal(result.status, 'failed');
  assert.match(result.markdown, /失敗を報告/);
});

// target_id: summarizeVitest(unknown,string,string)
test('treats a zero-test report as unresolved instead of a false success', () => {
  // Arrange
  const report = { numTotalTests: 0, numPassedTests: 0, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, success: true };
  // Act
  const result = summarizeVitest(report, 'unit', 'vitest.json');
  // Assert
  assert.deepEqual([result.status, result.collection], ['unresolved', 'unavailable']);
  assert.match(result.markdown, /テストが含まれていません/);
});
