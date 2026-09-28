import fs from 'node:fs';

// Usage (example):
// <runner> <script-path> --log "<path-to-json-report>" [--name <summary-name>]
//
// Output format: skills/ci-github/references/ci-summary-format.reference.md

type AssertionResult = {
  status?: string;
  fullName?: string;
  title?: string;
  name?: string;
};

type TestResult = {
  assertionResults?: AssertionResult[];
};

type VitestJsonReport = {
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  numPendingTests?: number;
  numSkippedTests?: number;
  numTodoTests?: number;
  success?: boolean;
  testResults?: TestResult[];
};

type Summary = {
  total?: number;
  passed?: number;
  failed?: number;
  skipped?: number;
  todo?: number;
  success?: boolean;
  resultsComplete?: boolean;
  failedNames: string[];
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
};

const asNumber = (value: unknown): number | undefined => {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
};

const asArray = (value: unknown): unknown[] | undefined => {
  return Array.isArray(value) ? value : undefined;
};

const parseReport = (value: unknown): VitestJsonReport | null => {
  const record = asRecord(value);
  return record ? (record as VitestJsonReport) : null;
};

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

const computeSkipped = (
  pending: number | undefined,
  skippedOnly: number | undefined,
): number | undefined => {
  if (pending === undefined && skippedOnly === undefined) {
    return undefined;
  }
  // Vitest/Jest reports use these as alternative names for the skipped count.
  return pending ?? skippedOnly;
};

const resolveFailedAssertionName = (assertionRecord: Record<string, unknown>): string => {
  return (
    (typeof assertionRecord.fullName === 'string' && assertionRecord.fullName) ||
    (typeof assertionRecord.title === 'string' && assertionRecord.title) ||
    (typeof assertionRecord.name === 'string' && assertionRecord.name) ||
    'unknown'
  );
};

const extractAssertionCounters = (
  assertions: unknown[],
  failedNames: string[],
): { total: number; passed: number; failed: number; skipped: number; todo: number } => {
  let total = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let todo = 0;

  for (const assertion of assertions) {
    total += 1;
    const assertionRecord = asRecord(assertion);
    if (!assertionRecord) {
      continue;
    }
    const status = assertionRecord.status;
    if (status === 'passed') {
      passed += 1;
      continue;
    }
    if (status === 'failed') {
      failed += 1;
      failedNames.push(resolveFailedAssertionName(assertionRecord));
      continue;
    }
    if (status === 'todo') {
      todo += 1;
      continue;
    }
    if (status === 'skipped' || status === 'pending') {
      skipped += 1;
    }
  }

  return { total, passed, failed, skipped, todo };
};

const extractSummaryFromTestResults = (
  testResults: unknown[],
  failedNames: string[],
): Summary => {
  let computedTotal = 0;
  let computedPassed = 0;
  let computedFailed = 0;
  let computedSkipped = 0;
  let computedTodo = 0;
  let resultsComplete = true;

  for (const testResult of testResults) {
    const record = asRecord(testResult);
    if (!record) {
      resultsComplete = false;
      continue;
    }
    const assertions = asArray(record.assertionResults);
    if (!assertions) {
      resultsComplete = false;
      continue;
    }
    const counters = extractAssertionCounters(assertions, failedNames);
    computedTotal += counters.total;
    computedPassed += counters.passed;
    computedFailed += counters.failed;
    computedSkipped += counters.skipped;
    computedTodo += counters.todo;
  }

  return {
    total: computedTotal,
    passed: computedPassed,
    failed: computedFailed,
    skipped: computedSkipped,
    todo: computedTodo,
    resultsComplete,
    failedNames,
  };
};

const extractSummary = (report: VitestJsonReport): Summary => {
  const failedNames: string[] = [];
  const total = asNumber(report.numTotalTests);
  const passed = asNumber(report.numPassedTests);
  const failed = asNumber(report.numFailedTests);
  const pending = asNumber(report.numPendingTests);
  const skippedOnly = asNumber(report.numSkippedTests);
  const skipped = computeSkipped(pending, skippedOnly);
  const todo = asNumber(report.numTodoTests);
  const success = typeof report.success === 'boolean' ? report.success : undefined;

  const summary: Summary = {
    total,
    passed,
    failed,
    skipped,
    todo,
    success,
    resultsComplete: true,
    failedNames,
  };
  const testResults = asArray(report.testResults);
  if (!testResults) {
    return summary;
  }
  const hasCompleteCounts = [total, passed, failed, skipped, todo]
    .every((value) => value !== undefined);
  if (hasCompleteCounts) {
    return summary;
  }
  const derived = extractSummaryFromTestResults(testResults, failedNames);
  summary.resultsComplete = derived.resultsComplete;
  summary.total ??= derived.total;
  summary.passed ??= derived.passed;
  summary.failed ??= derived.failed;
  summary.skipped ??= derived.skipped;
  summary.todo ??= derived.todo;
  return summary;
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

const renderUnavailableSummary = (summaryName: string, note: string, scope?: string): string => {
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
  console.log(renderUnavailableSummary(summaryName, 'テストレポートが見つかりません', logPath));
  process.exit(0);
}

let parsed: unknown;
try {
  parsed = JSON.parse(fs.readFileSync(logPath, 'utf8'));
} catch {
  console.log(renderUnavailableSummary(summaryName, 'テストレポートが見つからないか、形式が不正です', logPath));
  process.exit(0);
}

const report = parseReport(parsed);
if (!report) {
  console.log(renderUnavailableSummary(summaryName, 'テストレポートが見つからないか、形式が不正です', logPath));
  process.exit(0);
}

const summary = extractSummary(report);
const countValues = [summary.total, summary.passed, summary.failed, summary.skipped, summary.todo];
const hasAnyCount = countValues.some((value) => value !== undefined);
const hasCompleteCounts = countValues.every((value) => value !== undefined);
const hasConsistentCounts = summary.resultsComplete !== false && hasCompleteCounts && summary.total === (
  (summary.passed ?? 0)
  + (summary.failed ?? 0)
  + (summary.skipped ?? 0)
  + (summary.todo ?? 0)
);
const outcome = (summary.failed ?? 0) > 0 || summary.success === false
  ? 'failed'
  : hasConsistentCounts
    ? 'passed'
    : 'indeterminate';
const collection = hasConsistentCounts ? 'complete' : hasAnyCount ? 'partial' : 'unavailable';
const resultDetail = outcome === 'failed'
  ? summary.failed === undefined ? undefined : `${summary.failed}件`
  : summary.total === undefined ? undefined : `${summary.total}件`;
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
  ['total', summary.total],
  ['passed', summary.passed],
  ['failed', summary.failed],
  ['skipped', summary.skipped],
  ['todo', summary.todo],
]
  .filter(([, value]) => value !== undefined)
  .map(([name, value]) => `${name === 'total' ? '総数' : name === 'passed' ? '成功' : name === 'failed' ? '失敗' : name === 'skipped' ? 'スキップ' : 'TODO'} ${value}件`);
if (countParts.length > 0) {
  const totalPart = countParts.find((part) => part.startsWith('総数 '));
  const details = countParts.filter((part) => !part.startsWith('総数 ')).join(' / ');
  const total = totalPart ? totalPart.replace('総数 ', '') : '';
  lines.push(`- テスト: ${total}${details ? `（${details}）` : ''}`);
}
if (summary.failedNames.length > 0) {
  const limit = 10;
  lines.push('- 失敗:');
  for (const name of summary.failedNames.slice(0, limit)) {
    lines.push(`  - ${escapeMarkdownText(name)}`);
  }
  if (summary.failedNames.length > limit) {
    lines.push(`  - ほか ${summary.failedNames.length - limit}件`);
  }
}

if (!hasAnyCount && summary.failedNames.length === 0) {
  lines.push('- 理由: テストレポートに利用可能な件数がありません');
} else if (!hasConsistentCounts) {
  lines.push('- 理由: テストレポートの件数が不足しているか、整合していません');
}

lines.push('', '</details>');
console.log(lines.join('\n'));
