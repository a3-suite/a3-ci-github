import fs from 'node:fs';
import path from 'node:path';
import * as core from '@actions/core';
import { parseVitestReport, summarizeVitest } from './summary.js';

export const run = (): void => {
  try {
    const reportPath = core.getInput('report-json', { required: true });
    if (!reportPath || /[\0\r\n]/.test(reportPath)) throw new Error('ci-vitest-report-path-invalid');
    const label = core.getInput('label') || 'tests';
    let report = null;
    try { report = parseVitestReport(fs.readFileSync(reportPath, 'utf8')); } catch { report = null; }
    const result = summarizeVitest(report, label, reportPath);
    const outputPath = core.getInput('summary-path') || process.env.GITHUB_STEP_SUMMARY;
    if (outputPath) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.appendFileSync(outputPath, result.markdown, 'utf8');
      core.setOutput('summary-path', outputPath);
    } else {
      process.stdout.write(result.markdown);
      core.setOutput('summary-path', '');
    }
    core.setOutput('status', result.status);
    core.setOutput('collection', result.collection);
    core.setOutput('digest', result.digest);
  } catch (error) {
    core.setOutput('status', 'failed');
    core.setOutput('collection', 'unavailable');
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
};

if (process.env.GITHUB_ACTIONS === 'true') run();
