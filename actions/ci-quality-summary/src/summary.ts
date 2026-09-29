import { createHash } from 'node:crypto';

const RESULTS = ['success', 'failed', 'blocked', '判定不能', '未実施', '対象外'] as const;
const COLLECTIONS = ['完了', '一部取得', '取得不可'] as const;
type Result = (typeof RESULTS)[number];
type Collection = (typeof COLLECTIONS)[number];

export type SummaryRow = {
  unit: string;
  execution: string;
  result: Result;
  evidence: string;
  collection: Collection;
  reason?: string;
};

export type QualitySummaryInput = {
  jobs?: SummaryRow[];
  tests?: SummaryRow[];
};

export type RenderedSummary = {
  markdown: string;
  status: 'success' | 'failed' | 'blocked' | 'unresolved';
  digest: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const normalize = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/.test(value)) {
    throw new Error(`ci-summary-${field}-invalid`);
  }
  return value;
};

const rawResult = (
  value: string,
  applicable: boolean,
): Pick<SummaryRow, 'result' | 'collection'> => {
  if (!applicable) return { result: '対象外', collection: '完了' };
  if (value === 'success') return { result: 'success', collection: '完了' };
  if (value === 'failure') return { result: 'failed', collection: '完了' };
  if (value === 'cancelled') return { result: '未実施', collection: '一部取得' };
  if (value === 'skipped') return { result: '未実施', collection: '取得不可' };
  return { result: '判定不能', collection: '取得不可' };
};

const parseRows = (value: unknown, section: string): SummaryRow[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`ci-summary-${section}-invalid`);
  return value.map((row) => {
    if (!isRecord(row)) throw new Error('ci-summary-row-invalid');
    const common = {
      unit: normalize(row.unit, 'unit'),
      execution: normalize(row.execution, 'execution'),
      evidence: normalize(row.evidence, 'evidence'),
    };
    let parsed: SummaryRow;
    if (row.rawResult !== undefined) {
      if (row.result !== undefined || row.collection !== undefined) {
        throw new Error('ci-summary-result-source-ambiguous');
      }
      if (typeof row.applicable !== 'boolean') throw new Error('ci-summary-applicable-invalid');
      const sourceResult = normalize(row.rawResult, 'raw-result');
      parsed = { ...common, ...rawResult(sourceResult, row.applicable) };
      if (row.reason !== undefined) parsed.reason = normalize(row.reason, 'reason');
      else if (row.applicable && parsed.result !== 'success') parsed.reason = `job result: ${sourceResult}`;
    } else {
      if (row.applicable !== undefined) throw new Error('ci-summary-result-source-ambiguous');
      const result = normalize(row.result, 'result') as Result;
      if (!RESULTS.includes(result)) throw new Error('ci-summary-result-invalid');
      const collection = normalize(row.collection, 'collection') as Collection;
      if (!COLLECTIONS.includes(collection)) throw new Error('ci-summary-collection-invalid');
      parsed = { ...common, result, collection };
      if (row.reason !== undefined) parsed.reason = normalize(row.reason, 'reason');
    }
    if (parsed.result !== 'success' && !parsed.reason) throw new Error('ci-summary-reason-required');
    return parsed;
  });
};

const parseInput = (value: unknown): QualitySummaryInput => {
  if (!isRecord(value)) throw new Error('ci-summary-input-invalid');
  const jobs = parseRows(value.jobs, 'jobs');
  const tests = parseRows(value.tests, 'tests');
  if (jobs.length === 0 && tests.length === 0) throw new Error('ci-summary-rows-invalid');
  return { jobs, tests };
};

const escapeCell = (value: string): string => value.replaceAll('|', '\\|');
const escapeInline = (value: string): string => value.replaceAll('|', '\\|').replaceAll('`', '\\`');
// 設計上の対象外は実行状態ではないため、集約の対象から除外する。
const isExcluded = (row: SummaryRow): boolean => row.result === '対象外';
const resultLabel = (result: Result): string => ({
  success: '✅ 成功',
  failed: '❌ 失敗',
  blocked: '⚠️ 判定不能',
  判定不能: '⚠️ 判定不能',
  未実施: '⏭ 未実施',
  対象外: '⏭ 対象外',
}[result]);

const renderTable = (title: string, heading: string, rows: SummaryRow[]): string[] => [
  `## ${title}`,
  '',
  `| ${heading} | 実施 | 結果 |`,
  '|:--|:--|:--:|',
  ...rows.map((row) => `| \`${escapeInline(row.unit)}\` | ${escapeCell(row.execution)} | ${resultLabel(row.result)} |`),
];

const aggregateStatus = (rows: SummaryRow[]): RenderedSummary['status'] => {
  const considered = rows.filter((row) => !isExcluded(row));
  if (considered.some((row) => row.result === 'failed')) return 'failed';
  if (considered.some((row) => row.result === '判定不能')) return 'unresolved';
  if (considered.some((row) => row.collection !== '完了')) return 'unresolved';
  if (considered.some((row) => row.result === 'blocked' || row.result === '未実施')) return 'blocked';
  return 'success';
};

export const renderQualitySummary = (value: unknown): RenderedSummary => {
  const parsed = parseInput(value);
  const rows = [...(parsed.jobs ?? []), ...(parsed.tests ?? [])];
  if (rows.every((row) => isExcluded(row))) throw new Error('ci-summary-all-excluded');
  const lines: string[] = [];
  if (parsed.jobs?.length) lines.push(...renderTable('ジョブサマリ', 'ジョブ', parsed.jobs), '');
  if (parsed.tests?.length) lines.push(...renderTable('テストサマリ', 'テスト', parsed.tests), '');
  const details = rows.filter((row) => row.result !== 'success' || row.reason || row.collection !== '完了');
  if (details.length) {
    lines.push('<details>', '<summary>結果の詳細</summary>', '');
    for (const row of details) {
      lines.push(`- 判定: ${resultLabel(row.result)}`, `- 収集: ${row.collection}`, `- 対象: \`${escapeInline(row.unit)}\``, `- 証跡: \`${escapeInline(row.evidence)}\``);
      if (row.reason) lines.push(`- 理由: ${escapeCell(row.reason)}`);
    }
    lines.push('', '</details>');
  }
  const markdown = `${lines.join('\n').replace(/\n+$/, '')}\n`;
  const digest = `sha256:${createHash('sha256').update(markdown, 'utf8').digest('hex')}`;
  return { markdown, status: aggregateStatus(rows), digest };
};
