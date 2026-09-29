import fs from 'node:fs';
import path from 'node:path';
import * as core from '@actions/core';
import { pathsReferToSameFile } from '../../../runtime/path/same-file-core.mjs';
import { renderQualitySummary } from './summary.js';

export const run = (): void => {
  try {
    const raw = core.getInput('summary-json', { required: true });
    let input: unknown;
    try {
      input = JSON.parse(raw);
    } catch {
      throw new Error('ci-summary-json-invalid');
    }
    const result = renderQualitySummary(input);
    const outputPath = core.getInput('summary-path') || process.env.GITHUB_STEP_SUMMARY;
    if (!outputPath) throw new Error('ci-summary-path-missing');
    const evidencePath = core.getInput('evidence-path') || '.ci/ci-quality-summary.evidence.md';
    if (pathsReferToSameFile(outputPath, evidencePath, 'ci-summary-path-invalid')) {
      throw new Error('ci-summary-paths-must-differ');
    }
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, result.markdown, 'utf8');
    fs.appendFileSync(outputPath, result.markdown, 'utf8');
    core.setOutput('status', result.status);
    core.setOutput('digest', result.digest);
    core.setOutput('evidence-path', evidencePath);
    if (result.status !== 'success') core.setFailed(`ci-summary-${result.status}`);
  } catch (error) {
    core.setOutput('status', 'failed');
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
};

if (process.env.GITHUB_ACTIONS === 'true') run();
