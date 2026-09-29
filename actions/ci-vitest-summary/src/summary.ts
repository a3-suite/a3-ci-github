import { createHash } from 'node:crypto';

import { classifyVitestReport, parseVitestReport as parseVitestReportValue } from '../../../runtime/vitest/vitest-summary-core.mjs';

export type VitestSummary = {
  markdown: string;
  status: 'passed' | 'failed' | 'unresolved';
  collection: 'complete' | 'partial' | 'unavailable';
  digest: string;
};

const safe = (value: string): string => value.replace(/[\r\n]+/g, ' ').replaceAll('`', '\\`');

const renderOutcome = (status: string): string =>
  status === 'passed' ? '成功' : status === 'failed' ? '失敗' : '判定不能';

const renderCollection = (collection: string): string =>
  collection === 'complete' ? '完了' : collection === 'partial' ? '一部取得' : '取得不可';

export const parseVitestReport = (raw: string): unknown => parseVitestReportValue(raw);

export const summarizeVitest = (report: unknown, label: string, filePath: string): VitestSummary => {
  const classification = classifyVitestReport(report);
  const { counts } = classification;
  const lines = [
    `### ${safe(label)} テスト結果`,
    `- 判定: ${renderOutcome(classification.status)}`,
    `- 収集: ${renderCollection(classification.collection)}`,
    `- 対象: \`${safe(filePath)}\``,
  ];
  if (counts.total !== null) {
    lines.push(`- テスト: ${counts.total}件（成功 ${counts.passed ?? 0} / 失敗 ${counts.failed ?? 0} / スキップ ${counts.skipped ?? 0} / TODO ${counts.todo ?? 0}）`);
  }
  for (const item of classification.diagnostics) {
    lines.push(`- 理由: ${item.message}`);
  }
  const markdown = `${lines.join('\n')}\n`;
  const digest = `sha256:${createHash('sha256').update(markdown, 'utf8').digest('hex')}`;
  return { markdown, status: classification.status, collection: classification.collection, digest };
};
