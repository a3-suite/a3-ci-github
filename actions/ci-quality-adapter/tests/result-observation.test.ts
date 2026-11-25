import { test, expect } from 'vitest';
import { statusMatchesResults } from './result-observation';

// target_id: statusMatchesResults
// Guards the predicate that the mapped tests apply to the real Action results.
test('status consistency rejects success reported over a not-run command other than an unconfigured optional command', () => {
  // Arrange
  const unconfiguredPolicy = { id: 'dependency-policy', status: 'not-run', reason: 'not-configured' };
  const unconfiguredLint = { id: 'lint', status: 'not-run', reason: 'not-configured' };
  const skippedLint = { id: 'lint', status: 'not-run', reason: 'skipped' };
  const passed = [{ id: 'test', status: 'success' }];
  // Act
  const outcomes = [
    statusMatchesResults({ status: 'success', results: [...passed, unconfiguredPolicy] }),
    statusMatchesResults({ status: 'success', results: [unconfiguredLint, ...passed] }),
    statusMatchesResults({ status: 'success', results: [skippedLint, ...passed] }),
    statusMatchesResults({ status: 'success', results: [{ ...unconfiguredPolicy, status: 'success' }, { id: 'test', status: '判定不能' }] }),
    statusMatchesResults({ status: 'failed', results: [skippedLint, ...passed] }),
  ];
  // Assert
  expect(outcomes).toStrictEqual([true, true, false, false, true]);
});
