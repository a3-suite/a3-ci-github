import test from 'node:test';
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
