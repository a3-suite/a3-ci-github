import { test, describe, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateActionTable } from '../runtime/repository/update-action-index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The catalog gate projects the repository that contains it, so contract cases run its --write CLI
// in a fixture repository whose actions carry the given metadata and README summaries.
const projectCatalog = (readmeText, actions) => {
  mkdirSync(path.join(root, 'tests/tmp'), { recursive: true });
  const fixture = mkdtempSync(path.join(root, 'tests/tmp/action-catalog-'));
  try {
    const write = (relative, content) => {
      mkdirSync(path.dirname(path.join(fixture, relative)), { recursive: true });
      writeFileSync(path.join(fixture, relative), content);
    };
    for (const relative of ['runtime/repository/update-action-index.mjs', 'runtime/diagnostics/failure.mjs']) write(relative, readFileSync(path.join(root, relative)));
    write('README.md', readmeText);
    for (const action of actions) {
      write(`actions/${action.directory}/action.yml`, `name: ${action.name}\ndescription: ${action.description}\n`);
      write(`actions/${action.directory}/README.md`, `# ${action.name}\n\n${action.readmeSummary}\n`);
    }
    const result = spawnSync(process.execPath, [path.join(fixture, 'runtime/repository/update-action-index.mjs'), '--write'], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    return readFileSync(path.join(fixture, 'README.md'), 'utf8');
  } finally { rmSync(fixture, { recursive: true, force: true }); }
};

const readme = `# project

## Action一覧

| Action | 用途 | 概要 |
| --- | --- | --- |
| [\`alpha\`](actions/alpha/README.md) | alpha を使うとき | alpha summary |

説明。
`;

describe("contract.repository-action-distribution.catalog", () => {
  describe("repository-action-distribution-gates", () => {
    // contract_id: contract.repository-action-distribution.catalog
    // integration_id: repository-action-distribution-gates
    test('preserves curated rows and appends newly discovered actions', () => {
      // Arrange
      const actions = [
        { name: 'alpha', directory: 'alpha', description: 'alpha', readmeSummary: 'alpha' },
        { name: 'beta', directory: 'beta', description: 'beta description', readmeSummary: 'beta summary' },
      ];
      // Act
      const updated = projectCatalog(readme, actions);
      // Assert
      expect(updated).toMatch(/alpha.*alpha を使うとき.*alpha summary/);
      expect(updated).toMatch(/beta.*beta summary.*beta description/);
      expect(updated).toMatch(/action-catalog:start/);
      expect(updated).toMatch(/action-catalog:end/);
      expect(updated).toMatch(/action-catalog:start -->\n\n\| Action/);
      expect(updated).toMatch(/beta description \|\n\n<!-- action-catalog:end -->/);
    });

    // contract_id: contract.repository-action-distribution.catalog
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
      const updated = projectCatalog(catalogWithDeletedAction, [
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

describe("contract.repository-action-distribution.catalog", () => {
  describe("repository-action-distribution-gates", () => {
    // evidence_role: contract
    // test_level: integration
    // contract_id: contract.repository-action-distribution.catalog
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
        const once = projectCatalog(source, actions);
        const twice = projectCatalog(once, actions);
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
