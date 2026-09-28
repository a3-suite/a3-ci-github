export type VitestCounts = {
  total: number | null;
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  todo: number | null;
};

export type VitestDiagnostic = {
  code: string;
  message: string;
};

export type VitestClassification = {
  status: 'passed' | 'failed' | 'unresolved';
  collection: 'complete' | 'partial' | 'unavailable';
  counts: VitestCounts;
  failedNames: string[];
  diagnostics: VitestDiagnostic[];
};

export declare const VITEST_ASSERTION_STATUSES: readonly string[];

export declare function parseVitestReport(raw: string): Record<string, unknown> | null;

export declare function classifyVitestReport(report: unknown): VitestClassification;
