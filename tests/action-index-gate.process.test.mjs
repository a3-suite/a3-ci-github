import { test, describe, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The catalog gate projects the repository that contains it, so contract cases run its --write CLI
// in a fixture repository whose actions carry the given metadata and README summaries.
const runCatalog = (readmeText, actions, mode) => {
  mkdirSync(path.join(root, 'tests/tmp'), { recursive: true });
  const fixture = mkdtempSync(path.join(root, 'tests/tmp/action-catalog-'));
  try {
    const write = (relative, content) => {
      mkdirSync(path.dirname(path.join(fixture, relative)), { recursive: true });
      writeFileSync(path.join(fixture, relative), content);
    };
    for (const relative of ['runtime/repository/update-action-index.mjs', 'runtime/diagnostics/failure.mjs']) write(relative, readFileSync(path.join(root, relative)));
    if (readmeText !== null) write('README.md', readmeText);
    for (const action of actions) {
      write(`actions/${action.directory}/action.yml`, action.metadata ?? `name: ${action.name}\ndescription: ${action.description}\n`);
      write(`actions/${action.directory}/README.md`, `# ${action.name}\n\n${action.readmeSummary}\n`);
    }
    const result = spawnSync(process.execPath, [path.join(fixture, 'runtime/repository/update-action-index.mjs'), mode], { encoding: 'utf8' });
    const readmePath = path.join(fixture, 'README.md');
    return { result, readme: existsSync(readmePath) ? readFileSync(readmePath, 'utf8') : null };
  } finally { rmSync(fixture, { recursive: true, force: true }); }
};

const projectCatalog = (readmeText, actions) => {
  const { result, readme } = runCatalog(readmeText, actions, '--write');
  expect(result.status, result.stderr).toBe(0);
  return readme;
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
    // flow_id: repository-action-distribution-gates
    test('reports the projection stage when the catalog is stale', () => {
      const { result, readme: after } = runCatalog(readme, [
        { name: 'alpha', directory: 'alpha', description: 'alpha', readmeSummary: 'alpha' },
        { name: 'beta', directory: 'beta', description: 'beta', readmeSummary: 'beta' },
      ], '--check');

      expect(result.status).toBe(1);
      const diagnostic = result.stderr.match(/^ci-failure-diagnostic:(.+)$/m);
      expect(diagnostic).not.toBeNull();
      expect(JSON.parse(diagnostic[1]).classification).toMatchObject({ stage: 'catalog-projection', reason: 'action-catalog-stale' });
      expect(after).toBe(readme);
    });

    const failedCatalogCases = [
      ['the README is missing', null, {}, 'catalog-input-read'],
      ['Action metadata lacks a description', readme, { metadata: 'name: alpha\n' }, 'action-metadata-validation'],
      ['the README lacks the catalog section', '# project\n', {}, 'catalog-projection'],
      ['the catalog section lacks the table', '# project\n\n## Action一覧\n\nNo table.\n', {}, 'catalog-projection'],
    ];
    const runFailedCatalog = (source, metadata) => runCatalog(source, [
      { name: 'alpha', directory: 'alpha', description: 'alpha', readmeSummary: 'alpha', ...metadata },
    ], '--check');

    // contract_id: contract.repository-action-distribution.catalog
    // flow_id: repository-action-distribution-gates
    test.each(failedCatalogCases)('reports the failed stage when %s', (_case, source, metadata, stage) => {
      const { result } = runFailedCatalog(source, metadata);

      expect(result.status).toBe(1);
      const diagnostic = result.stderr.match(/^ci-failure-diagnostic:(.+)$/m);
      expect(diagnostic, result.stderr).not.toBeNull();
      expect(JSON.parse(diagnostic[1]).classification).toMatchObject({ subject: 'repository-action-distribution', stage });
    });

    // evidence_role: supplemental
    // flow_id: repository-action-distribution-gates
    test.each(failedCatalogCases)('preserves the README when %s', (_case, source, metadata) => {
      const { readme: after } = runFailedCatalog(source, metadata);
      expect(after).toBe(source);
    });

    // contract_id: contract.repository-action-distribution.catalog
    // flow_id: repository-action-distribution-gates
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
    // flow_id: repository-action-distribution-gates
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

describe("contract.repository-action-distribution.catalog", () => {
  describe("repository-action-distribution-gates", () => {
    // evidence_role: supplemental
    // Exercise the CLI across several surrounding README layouts.
    // contract_id: contract.repository-action-distribution.catalog
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
