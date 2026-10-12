import { completeFailure, FailureContext, writeFailureOutputs, safeErrorReason, readActionInput, DiagnosticError } from '../../../runtime/diagnostics/failure.mjs';
import fs from 'node:fs';
import path from 'node:path';
import * as core from '@actions/core';
import { pathsReferToSameFile } from '../../../runtime/path/same-file-core.mjs';
import { parseVitestReport, summarizeVitest } from './summary.js';

export const run = (): void => {
  const diagnostic = new FailureContext('ci-vitest-summary', 'vitest-summary');
  try {
    diagnostic.at('report-read', {"input": "report-json"});
    const reportPath = readActionInput(core.getInput, 'report-json', { required: true });
    if (!reportPath || /[\0\r\n]/.test(reportPath)) throw new DiagnosticError('ci-vitest-report-path-invalid');
    const label = readActionInput(core.getInput, 'label') || 'tests';
    let report: unknown = null;
    try { report = parseVitestReport(fs.readFileSync(reportPath, 'utf8')); } catch { report = null; }
    diagnostic.confirmed();
    diagnostic.at('report-classification', {"input": "report-json"});
    const result = summarizeVitest(report, label, reportPath);
    const outputPath = readActionInput(core.getInput, 'summary-path') || process.env.GITHUB_STEP_SUMMARY;
    if (outputPath) {
      if (pathsReferToSameFile(reportPath, outputPath, 'ci-vitest-summary-path-invalid')) {
        throw new DiagnosticError('ci-vitest-summary-paths-must-differ');
      }
    diagnostic.confirmed();
    diagnostic.at('summary-write', {"output": "summary-path"});
    diagnostic.writeState = 'write-may-be-partial';
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.appendFileSync(outputPath, result.markdown, 'utf8');
      core.setOutput('summary-path', outputPath);
    } else {
      process.stdout.write(result.markdown);
      core.setOutput('summary-path', '');
    }
    diagnostic.confirmed();
    diagnostic.at('output-write', {"output": "GITHUB_OUTPUT"});
    diagnostic.writeState = 'write-may-be-partial';
    core.setOutput('status', result.status);
    core.setOutput('collection', result.collection);
    core.setOutput('digest', result.digest);
    if (result.status !== 'passed') {
      diagnostic.outcome = result.status;
      diagnostic.at('report-result', { input: 'report-json', evidence: 'summary-path' });
      diagnostic.report(new DiagnosticError(`vitest-report-${result.status}`, { diagnostics: { field: 'report-status', expected: 'passed', observed: result.status, collection: result.collection } }));
    }
  } catch (error) {
    diagnostic.report(error);
    writeFailureOutputs(core.setOutput, [['status', 'failed'], ['collection', 'unavailable']], diagnostic);
    completeFailure(safeErrorReason(error), 1, core.setFailed);
  }
};

if (process.env.GITHUB_ACTIONS === 'true') run();
