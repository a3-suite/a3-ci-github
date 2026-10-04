import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, describe, expect } from 'vitest';
import { fileURLToPath } from 'node:url';

import { pathsReferToSameFile } from '../same-file-core.mjs';

describe("pathsReferToSameFile(left, right, invalidCode)", () => {
  // evidence_role: supplemental
  // test_level: unit
  // target_id: pathsReferToSameFile(left, right, invalidCode)
  // Invalid caller codes are a local precondition; Action entrypoints cover file aliases.
  test('requires an explicit error code before filesystem access', () => {
    // Arrange
    const codes = [undefined, ''];
    // Act
    const failures = codes.map((code) => {
      try { pathsReferToSameFile('left', 'right', code); } catch (error) { return error; }
      return undefined;
    });
    // Assert
    for (const failure of failures) {
      expect(failure instanceof Error).toBeTruthy();
      expect(failure.message).toBe('same-file-invalid-code');
    }
  });
});

describe("shared-file-identity-regression", () => {
  // evidence_role: supplemental
  // test_level: integration
  // integration_id: shared-file-identity-regression
  // Different existing files exercise the inode comparison that fresh Action outputs do not.
  test('distinguishes existing and missing files without a false alias', (t) => {
    // Arrange
    const parent = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../tests/tmp');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(path.join(parent, 'file-identity-'));
    t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    const left = path.join(root, 'left.txt');
    const right = path.join(root, 'right.txt');
    writeFileSync(left, 'left');
    writeFileSync(right, 'right');
    const pairs = [
      [left, right],
      [path.join(root, 'missing-a.txt'), path.join(root, 'missing-b.txt')],
      [left, path.join(root, 'missing.txt')],
    ];
    // Act
    const sameFile = pairs.map(([first, second]) => pathsReferToSameFile(first, second, 'same-file-test-invalid'));
    // Assert
    expect(sameFile).toStrictEqual([false, false, false]);
  });
});
