import { strict as assert } from 'node:assert';
import test from 'node:test';
import { parseFutureRfc3339 } from '../src/control.js';

// target_id: parseFutureRfc3339(string)
test('rejects expired approval timestamps', () => {
  // Arrange
  let failure: unknown;

  // Act
  try {
    parseFutureRfc3339('2000-01-01T00:00:00Z');
  } catch (error) {
    failure = error;
  }

  // Assert
  assert.match(String(failure), /expired/);
});

// target_id: parseFutureRfc3339(string)
test('accepts RFC 3339 timezone and leap-second boundaries', () => {
  // Arrange
  const cases = [
    '2999-01-01T00:00:00.123Z',
    '2999-01-01T00:00:00+09:30',
    '2999-12-31T23:59:60Z',
  ];

  // Act
  const epochs = cases.map((value) => parseFutureRfc3339(value, 0));

  // Assert
  epochs.forEach((epoch) => assert.ok(Number.isFinite(epoch)));
});

// target_id: parseFutureRfc3339(string)
test('rejects malformed RFC 3339 timestamp boundaries', () => {
  // Arrange
  const cases = [
    '2999-01-01',
    '0000-01-01T00:00:00Z',
    '2999-00-01T00:00:00Z',
    '2999-13-01T00:00:00Z',
    '2999-01-01T24:00:00Z',
    '2999-01-01T00:60:00Z',
    '2999-01-01T00:00:61Z',
    '2999-01-01T00:00:00+24:00',
    '2999-01-01T00:00:00+00:60',
    '2999-02-29T00:00:00Z',
    '2999-01-01T23:59:60Z',
  ];
  const failures: unknown[] = [];

  // Act
  for (const value of cases) {
    try { parseFutureRfc3339(value, 0); } catch (error) { failures.push(error); }
  }

  // Assert
  assert.equal(failures.length, cases.length);
  failures.forEach((failure) => assert.match(String(failure), /not a valid RFC 3339 timestamp/));
});
