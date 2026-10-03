import { test } from 'vitest';
import assert from 'node:assert/strict';
import { updateActionTable } from '../runtime/repository/update-action-index.mjs';

const readme = `# project

## Action一覧

| Action | 用途 | 概要 |
| --- | --- | --- |
| [\`alpha\`](actions/alpha/README.md) | alpha を使うとき | alpha summary |

説明。
`;

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
  assert.match(updated, /alpha.*alpha を使うとき.*alpha summary/);
  assert.match(updated, /beta.*beta summary.*beta description/);
  assert.match(updated, /action-catalog:start/);
  assert.match(updated, /action-catalog:end/);
  assert.match(updated, /action-catalog:start -->\n\n\| Action/);
  assert.match(updated, /beta description \|\n\n<!-- action-catalog:end -->/);
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
  assert.doesNotMatch(updated, /\[`beta`\]/);
});

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
  assert.match(updated, /\| \[`beta`\].*beta summary first line, second line\..*beta description \|/);
  assert.doesNotMatch(updated, /beta summary first line,\nsecond line/);
});

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
    assert.equal(twice, once);
    assert.equal((once.match(/action-catalog:start/g) ?? []).length, 1);
    assert.equal((once.match(/action-catalog:end/g) ?? []).length, 1);
    assert.match(once, /alpha を使うとき.*alpha summary/);
    if (source.includes('## Installation')) assert.ok(once.endsWith(nextSection));
    if (source.includes('説明。')) assert.match(once, /説明。/);
  }
});

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
    assert.throws(() => updateActionTable(source, []), message);
  }
});
