import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { test, describe, expect } from 'vitest';
import { collectSubjectCoverage } from '../../../tests/coverage-tools/contract-subject-coverage.mjs';

describe("repository-coverage-aggregation", () => {
  // integration_id: repository-coverage-aggregation
  // evidence_role: supplemental
  // test_level: integration
  test('non-measured segments execute only the selected checkout test set', () => {
    // Arrange
    const temporaryRoot = path.resolve('tests/tmp');
    mkdirSync(temporaryRoot, { recursive: true });
    const root = mkdtempSync(path.join(temporaryRoot, 'coverage-selected-checkout-'));
    try {
      mkdirSync(path.join(root, 'custom'));
      writeFileSync(path.join(root, 'custom/selected.test.mjs'), "import { test } from 'vitest'; import { writeFileSync } from 'node:fs'; test('selected checkout', () => writeFileSync(new URL('./executed', import.meta.url), 'selected'));\n");
      writeFileSync(path.join(root, 'custom/unselected.test.mjs'), "throw new Error('unselected test must not run');\n");
      const subject = { subjectId: 'selected', segments: [{ id: 'observations', level: 'integration', cwd: 'custom', tests: ['selected.test.mjs'], coverage: { enabled: false } }] };
      const reportRoot = path.join(root, 'reports');
      const planned = collectSubjectCoverage(subject, root, reportRoot, true);
      expect(planned.segments[0].status).toBe('planned');
      expect(existsSync(reportRoot)).toBe(false);
      // Act
      const result = collectSubjectCoverage(subject, root, reportRoot);
      // Assert
      expect(result.segments[0].status).toBe('passed');
      expect(readFileSync(path.join(root, 'custom/executed'), 'utf8')).toBe('selected');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

});
