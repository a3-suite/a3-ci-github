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
