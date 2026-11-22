import { test, describe, expect } from 'vitest';
import { updateActionTable } from '../runtime/repository/update-action-index.mjs';

const readme = `# project

## Action一覧

| Action | 用途 | 概要 |
| --- | --- | --- |
| [\`alpha\`](actions/alpha/README.md) | alpha を使うとき | alpha summary |

説明。
`;

describe("action-index-gate", () => {
  describe("repository-action-index-regression", () => {
    // integration_id: repository-action-index-regression
    test('normalizes a multiline Action summary into one table row', () => {
      // Arrange
      const actions = [
        { name: 'alpha', directory: 'alpha', description: 'alpha', readmeSummary: 'alpha' },
        {
          name: 'beta',
          directory: 'beta',
          description: 'beta description',
          readmeSummary: 'beta summary first line,\nsecond line.',
        },
      ];
      // Act
      const updated = updateActionTable(readme, actions);
      // Assert
      expect(updated).toMatch(/\| \[`beta`\].*beta summary first line, second line\..*beta description \|/);
      expect(updated).not.toMatch(/beta summary first line,\nsecond line/);
    });
  });
});

describe("action-index-gate", () => {
  describe("repository-action-index-regression", () => {
    // evidence_role: supplemental
    // test_level: integration
    // integration_id: repository-action-index-regression
    test('catalog projection rejects missing headings tables and undelimited table endings', () => {
      // Arrange
      const cases = [
        ['# project\n', /README.md is missing/],
        ['# project\n\n## Action一覧\n\nNo table.\n', /Action table could not be located/],
        ['# project\n\n## Action一覧\n| Action | 用途 | 概要 |\n| --- | --- | --- |\n', /Action table could not be located/],
      ];
      for (const [source, message] of cases) {
        // Act / Assert
        expect(() => updateActionTable(source, [])).toThrow(message);
      }
    });
  });
});
