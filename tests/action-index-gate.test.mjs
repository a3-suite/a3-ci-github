import { test, describe, expect } from 'vitest';
import { updateActionTable } from '../runtime/repository/update-action-index.mjs';

const readme = `# project

## Action一覧

| Action | 用途 | 概要 |
| --- | --- | --- |
| [\`alpha\`](actions/alpha/README.md) | alpha を使うとき | alpha summary |

説明。
`;

describe("contract.repository-action-distribution.integrity", () => {
  describe("repository-action-distribution-gates", () => {
    // contract_id: contract.repository-action-distribution.integrity
    // integration_id: repository-action-distribution-gates
    test('preserves curated rows and appends newly discovered actions', () => {
      // Arrange
      const actions = [
        { name: 'alpha', directory: 'alpha', description: 'alpha', readmeSummary: 'alpha' },
        { name: 'beta', directory: 'beta', description: 'beta description', readmeSummary: 'beta summary' },
      ];
      // Act
      const updated = updateActionTable(readme, actions);
      // Assert
      expect(updated).toMatch(/alpha.*alpha を使うとき.*alpha summary/);
      expect(updated).toMatch(/beta.*beta summary.*beta description/);
      expect(updated).toMatch(/action-catalog:start/);
      expect(updated).toMatch(/action-catalog:end/);
      expect(updated).toMatch(/action-catalog:start -->\n\n\| Action/);
      expect(updated).toMatch(/beta description \|\n\n<!-- action-catalog:end -->/);
    });

    // contract_id: contract.repository-action-distribution.integrity
    // integration_id: repository-action-distribution-gates
    test('removes rows for deleted actions', () => {
      // Arrange
      const catalogWithDeletedAction = readme.replace(
        '| [`alpha`](actions/alpha/README.md) | alpha を使うとき | alpha summary |\n',
        [
          '| [`alpha`](actions/alpha/README.md) | alpha を使うとき | alpha summary |',
          '| [`beta`](actions/beta/README.md) | beta を使うとき | beta summary |',
          '',
        ].join('\n'),
      );
      // Act
      const updated = updateActionTable(catalogWithDeletedAction, [
        { name: 'alpha', directory: 'alpha', description: 'alpha', readmeSummary: 'alpha' },
      ]);
      // Assert
      expect(updated).not.toMatch(/\[`beta`\]/);
    });
  });
});

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

describe("contract.repository-action-distribution.integrity", () => {
  describe("repository-action-distribution-gates", () => {
    // evidence_role: contract
    // test_level: integration
    // contract_id: contract.repository-action-distribution.integrity
    // integration_id: repository-action-distribution-gates
    test('catalog projection preserves section boundaries and is idempotent with generated markers', () => {
      // Arrange
      const actions = [{ name: 'alpha', directory: 'alpha', description: 'alpha', readmeSummary: 'alpha' }];
      const nextSection = '## Installation\n\nProject-owned installation text.\n';
      const variants = [
        readme + nextSection,
        readme.replace('\n\n説明。\n', '\n') + nextSection,
        readme,
      ];
      for (const source of variants) {
        // Act
        const once = updateActionTable(source, actions);
        const twice = updateActionTable(once, actions);
        // Assert
        expect(twice).toBe(once);
        expect((once.match(/action-catalog:start/g) ?? []).length).toBe(1);
        expect((once.match(/action-catalog:end/g) ?? []).length).toBe(1);
        expect(once).toMatch(/alpha を使うとき.*alpha summary/);
        if (source.includes('## Installation')) expect(once.endsWith(nextSection)).toBeTruthy();
        if (source.includes('説明。')) expect(once).toMatch(/説明。/);
      }
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
