import type { ActionTarget, Finding, RegistryData, ValueMap } from './preset-model.ts';

type Status = 'success' | 'failed';

type SemanticCandidate = {
  kind: 'unmanaged-workflow' | 'unreachable-asset' | 'unclassified-directory-asset'
    | 'action-local-overlap';
  path: string;
  relatedPaths: string[];
  message: string;
};

type InspectionContext = {
  root: string;
  registry: RegistryData;
  actionByPath: Map<string, ActionTarget>;
  parsed: Map<string, ValueMap>;
  report: Report;
};

type Report = {
  schemaVersion: '1';
  phase: 'provider-preflight';
  status: Status;
  inspectedPresets: string[];
  excludedPresets: string[];
  inspectedWorkflows: string[];
  excludedWorkflows: string[];
  missingSettings: Finding[];
  mismatches: Finding[];
  evidence: string[];
  semanticReviewRequired: boolean;
  semanticCandidates: SemanticCandidate[];
};

export const add = (findings: Finding[], finding: Finding): void => {
  if (!findings.some((item) => item.path === finding.path && item.message === finding.message)) {
    findings.push(finding);
  }
};

export const createReport = (): Report => ({
  schemaVersion: '1',
  phase: 'provider-preflight',
  status: 'success',
  inspectedPresets: [],
  excludedPresets: [],
  inspectedWorkflows: [],
  excludedWorkflows: [],
  missingSettings: [],
  mismatches: [],
  evidence: [],
  semanticReviewRequired: false,
  semanticCandidates: [],
});

export type { SemanticCandidate, InspectionContext, Report };
