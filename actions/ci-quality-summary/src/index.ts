import { completeFailure, FailureContext, writeFailureOutputs, safeErrorReason, readActionInput, DiagnosticError } from '../../../runtime/diagnostics/failure.mjs';
import fs from 'node:fs';
import path from 'node:path';
import * as core from '@actions/core';
import { pathsReferToSameFile } from '../../../runtime/path/same-file-core.mjs';
import { renderQualitySummary } from './summary.js';

export const run = (): void => {
  const diagnostic = new FailureContext('ci-quality-summary', 'quality-summary');
  try {
    diagnostic.at('summary-input', {"input": "summary-json"});
    const raw = readActionInput(core.getInput, 'summary-json', { required: true });
    let input: unknown;
    try {
      input = JSON.parse(raw);
    } catch {
      throw new DiagnosticError('ci-summary-json-invalid');
    }
    diagnostic.confirmed();
    diagnostic.at('summary-classification', {"input": "summary-json"});
    const result = renderQualitySummary(input);
    diagnostic.details.sourceOutcome = result.status;
    if (input && typeof input === 'object' && 'jobs' in input && Array.isArray(input.jobs)) {
      diagnostic.details.jobs = input.jobs.map((job: unknown) => {
        const value = job && typeof job === 'object' ? job as Record<string, unknown> : {};
        return {
          unit: typeof value.unit === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(value.unit) ? value.unit : 'unavailable',
          rawResult: ['success', 'failure', 'cancelled', 'skipped'].includes(String(value.rawResult)) ? value.rawResult : 'unavailable',
          evidence: typeof value.evidence === 'string' && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[0-9]+(?:\/job\/[0-9]+)?$/.test(value.evidence) ? value.evidence : 'configured-job-evidence',
        };
      });
    }
    const outputPath = readActionInput(core.getInput, 'summary-path') || process.env.GITHUB_STEP_SUMMARY;
    if (!outputPath) throw new DiagnosticError('ci-summary-path-missing');
    const evidencePath = readActionInput(core.getInput, 'evidence-path') || '.ci/ci-quality-summary.evidence.md';
    if (pathsReferToSameFile(outputPath, evidencePath, 'ci-summary-path-invalid')) {
      throw new DiagnosticError('ci-summary-paths-must-differ');
    }
    diagnostic.confirmed();
    diagnostic.at('evidence-write', {"output": "evidence-path"});
    diagnostic.writeState = 'write-may-be-partial';
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, result.markdown, 'utf8');
    diagnostic.retainedEvidence = 'configured-evidence-path';
    diagnostic.confirmed();
    diagnostic.at('summary-write', {"output": "summary-path"});
    diagnostic.writeState = 'write-may-be-partial';
    fs.appendFileSync(outputPath, result.markdown, 'utf8');
    diagnostic.confirmed();
    diagnostic.at('output-write', {"output": "GITHUB_OUTPUT"});
    diagnostic.writeState = 'write-may-be-partial';
    core.setOutput('status', result.status);
    core.setOutput('digest', result.digest);
    core.setOutput('evidence-path', evidencePath);
    if (result.status !== 'success') {
      diagnostic.outcome = result.status;
      diagnostic.at('summary-result', { input: 'summary-json', evidence: 'evidence-path' });
      diagnostic.report(new DiagnosticError(`ci-summary-${result.status}`, { diagnostics: { field: 'quality-status', expected: 'success', observed: result.status } }));
      completeFailure(`ci-summary-${result.status}`, 1, core.setFailed);
    }
  } catch (error) {
    diagnostic.report(error);
    writeFailureOutputs(core.setOutput, [['status', 'failed']], diagnostic);
    completeFailure(safeErrorReason(error), 1, core.setFailed);
  }
};

if (process.env.GITHUB_ACTIONS === 'true') run();
