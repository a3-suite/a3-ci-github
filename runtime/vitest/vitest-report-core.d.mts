export type VitestCounts = {
  total: number | null;
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  todo: number | null;
};

export type VitestClassification = {
  status: 'passed' | 'failed' | 'unresolved';
  collection: 'complete' | 'partial' | 'unavailable';
  counts: VitestCounts;
};

export declare function parseVitestReport(raw: string): Record<string, unknown> | null;

export declare function classifyVitestReport(report: unknown): VitestClassification;
