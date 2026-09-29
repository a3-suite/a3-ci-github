import fs from 'node:fs';

import { classifyVitestReport, parseVitestReport } from '../vitest/vitest-summary-core.mjs';

// Usage (example):
// <runner> <script-path> --log "<path-to-json-report>" [--name <summary-name>]
//
// Output format: skills/ci-github/references/ci-summary-format.reference.md

const normalizeLine = (value: string): string => value.replace(/[\r\n]+/g, ' ');

const escapeMarkdownText = (value: string): string => normalizeLine(value).replaceAll('`', '\\`');

const renderInlineCode = (value: string): string => {
  const normalized = normalizeLine(value);
  const runs = normalized.match(/`+/g) ?? [];
  const delimiter = '`'.repeat(Math.max(1, ...runs.map((run) => run.length)) + 1);
  const padding = normalized.startsWith('`') || normalized.endsWith('`') ? ' ' : '';
  return `${delimiter}${padding}${normalized}${padding}${delimiter}`;
};

const renderSummaryUnit = (value: string): string => {
  const normalized = normalizeLine(value).replaceAll('|', '\\|');
  return normalized.includes('`') ? renderInlineCode(normalized) : `\`${normalized}\``;
};

const renderOutcome = (outcome: string): string => {
  if (outcome === 'passed') return '成功';
  if (outcome === 'failed') return '失敗';
  return '判定不能';
};

const renderCollection = (collection: string): string => {
  if (collection === 'complete') return '完了';
  if (collection === 'partial') return '一部取得';
  return '取得不可';
};

const renderSummaryTable = (
  summaryName: string,
  outcome: string,
  action: string,
  resultDetail?: string,
): string => {
  const result = `${outcome === 'passed' ? '✅ 成功' : outcome === 'failed' ? '❌ 失敗' : '⚠️ 判定不能'}${resultDetail ? `（${resultDetail}）` : ''}`;
  return [
    '### テストサマリ',
    '',
    '| テスト | 実施 | 結果 |',
    '|:--|:--|:--:|',
    `| ${renderSummaryUnit(summaryName)} | ${action} | ${result} |`,
  ].join('\n');
};

// Minimal CLI parser for "--log <path>" style arguments.
const getArgValue = (name: string): string | undefined => {
  const prefix = `--${name}`;
  const inlinePrefix = `${prefix}=`;
  const inlineArg = process.argv.find((arg) => arg.startsWith(inlinePrefix));
  if (inlineArg) {
    const value = inlineArg.slice(inlinePrefix.length);
    return value.length > 0 ? value : undefined;
  }
  const index = process.argv.findIndex((arg) => arg === prefix);
  if (index === -1) {
    return undefined;
  }
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
};

const renderMissingReport = (summaryName: string, note: string, scope?: string): string => {
  const lines = [
    renderSummaryTable(summaryName, 'indeterminate', 'テストレポートを解析'),
    '',
    '<details>',
    '<summary>テスト結果の詳細</summary>',
    '',
    '### テスト結果',
    '- 判定: 判定不能',
    '- 収集: 取得不可',
  ];
  if (scope) {
    lines.push(`- 対象: ${renderInlineCode(scope)}`);
  }
  lines.push(`- 理由: ${note}`);
  lines.push('', '</details>');
  return lines.join('\n');
};

const logPath = getArgValue('log');
const summaryName = getArgValue('name') ?? 'テスト';
if (!logPath || !fs.existsSync(logPath)) {
  console.log(renderMissingReport(summaryName, 'テストレポートが見つかりません', logPath));
  process.exit(0);
}

let report: unknown = null;
try {
  report = parseVitestReport(fs.readFileSync(logPath, 'utf8'));
} catch {
  report = null;
}

const classification = classifyVitestReport(report);
const outcome = classification.status === 'passed'
  ? 'passed'
  : classification.status === 'failed'
    ? 'failed'
    : 'indeterminate';
const collection = classification.collection;
const { counts } = classification;
const resultDetail = outcome === 'failed'
  ? counts.failed === null ? undefined : `${counts.failed}件`
  : counts.total === null ? undefined : `${counts.total}件`;
const lines: string[] = [
  renderSummaryTable(summaryName, outcome, 'テストレポートを解析', resultDetail),
  '',
  '<details>',
  '<summary>テスト結果の詳細</summary>',
  '',
  '### テスト結果',
  `- 判定: ${renderOutcome(outcome)}`,
  `- 収集: ${renderCollection(collection)}`,
  `- 対象: ${renderInlineCode(logPath)}`,
];

const countParts = [
  ['total', counts.total],
  ['passed', counts.passed],
  ['failed', counts.failed],
  ['skipped', counts.skipped],
  ['todo', counts.todo],
]
  .filter(([, value]) => value !== null)
  .map(([name, value]) => `${name === 'total' ? '総数' : name === 'passed' ? '成功' : name === 'failed' ? '失敗' : name === 'skipped' ? 'スキップ' : 'TODO'} ${value}件`);
if (countParts.length > 0) {
  const totalPart = countParts.find((part) => part.startsWith('総数 '));
  const details = countParts.filter((part) => !part.startsWith('総数 ')).join(' / ');
  const total = totalPart ? totalPart.replace('総数 ', '') : '';
  lines.push(`- テスト: ${total}${details ? `（${details}）` : ''}`);
}
if (classification.failedNames.length > 0) {
  const limit = 10;
  lines.push('- 失敗:');
  for (const name of classification.failedNames.slice(0, limit)) {
    lines.push(`  - ${escapeMarkdownText(name)}`);
  }
  if (classification.failedNames.length > limit) {
    lines.push(`  - ほか ${classification.failedNames.length - limit}件`);
  }
}
for (const item of classification.diagnostics) {
  lines.push(`- 理由: ${item.message}`);
}

lines.push('', '</details>');
console.log(lines.join('\n'));
