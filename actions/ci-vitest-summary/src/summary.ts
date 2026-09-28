import { createHash } from 'node:crypto';

export type VitestReport = {
  numTotalTestSuites?: number;
  numPassedTestSuites?: number;
  numFailedTestSuites?: number;
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  numPendingTests?: number;
  numSkippedTests?: number;
  numTodoTests?: number;
  success?: boolean;
  testResults?: Array<{ assertionResults?: Array<{ status?: string }> }>;
};

export type VitestSummary = {
  markdown: string;
  status: 'passed' | 'failed' | 'unresolved';
  collection: 'complete' | 'partial' | 'unavailable';
  digest: string;
};

const count = (value: unknown): number | null => typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
const safe = (value: string): string => value.replace(/[\r\n]+/g, ' ').replaceAll('`', '\\`');

const derivedCounts = (results: unknown[]) => {
  const counts = { total: 0, passed: 0, failed: 0, skipped: 0, todo: 0 };
  for (const suite of results) {
    const assertions = typeof suite === 'object' && suite !== null && Array.isArray((suite as { assertionResults?: unknown }).assertionResults)
      ? (suite as { assertionResults: unknown[] }).assertionResults
      : [];
    for (const assertion of assertions) {
    counts.total += 1;
      const status = typeof assertion === 'object' && assertion !== null
        ? (assertion as { status?: unknown }).status
        : undefined;
      if (status === 'passed') counts.passed += 1;
      else if (status === 'failed') counts.failed += 1;
      else if (status === 'todo') counts.todo += 1;
      else if (status === 'skipped' || status === 'pending') counts.skipped += 1;
    }
  }
  return counts;
};

export const parseVitestReport = (raw: string): VitestReport | null => {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as VitestReport : null;
  } catch { return null; }
};

export const summarizeVitest = (report: VitestReport | null, label: string, filePath: string): VitestSummary => {
  const lines = [`### ${safe(label)} テスト結果`];
  if (!report) {
    lines.push('- 判定: 判定不能', '- 収集: 取得不可', `- 対象: \`${safe(filePath)}\``, '- 理由: テストレポートが見つからないか、形式が不正です');
    return finish(lines, 'unresolved', 'unavailable');
  }
  const fields = {
    total: count(report.numTotalTests), passed: count(report.numPassedTests), failed: count(report.numFailedTests),
    skipped: count(report.numPendingTests ?? report.numSkippedTests), todo: count(report.numTodoTests),
  };
  const rawResults = (report as { testResults?: unknown }).testResults;
  const resultsComplete = rawResults === undefined
    || (Array.isArray(rawResults) && rawResults.every((suite) => typeof suite === 'object' && suite !== null && Array.isArray((suite as { assertionResults?: unknown }).assertionResults)));
  const derived = Array.isArray(rawResults) ? derivedCounts(rawResults) : undefined;
  for (const key of Object.keys(fields) as (keyof typeof fields)[]) if (fields[key] === null && derived) fields[key] = derived[key];
  const complete = Object.values(fields).every((value) => value !== null)
    && resultsComplete !== false
    && fields.total === (fields.passed! + fields.failed! + fields.skipped! + fields.todo!);
  const anyCount = Object.values(fields).some((value) => value !== null);
  const collection = complete ? 'complete' : anyCount ? 'partial' : 'unavailable';
  const status = fields.failed! > 0 || report.success === false ? 'failed' : complete ? 'passed' : 'unresolved';
  lines.push(`- 判定: ${status === 'passed' ? '成功' : status === 'failed' ? '失敗' : '判定不能'}`, `- 収集: ${collection === 'complete' ? '完了' : collection === 'partial' ? '一部取得' : '取得不可'}`, `- 対象: \`${safe(filePath)}\``);
  if (fields.total !== null) lines.push(`- テスト: ${fields.total}件（成功 ${fields.passed ?? 0} / 失敗 ${fields.failed ?? 0} / スキップ ${fields.skipped ?? 0} / TODO ${fields.todo ?? 0}）`);
  if (!complete) lines.push('- 理由: テストレポートの件数が不足しているか、整合していません');
  return finish(lines, status, collection);
};

const finish = (lines: string[], status: VitestSummary['status'], collection: VitestSummary['collection']): VitestSummary => {
  const markdown = `${lines.join('\n')}\n`;
  return { markdown, status, collection, digest: `sha256:${createHash('sha256').update(markdown).digest('hex')}` };
};
