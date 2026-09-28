import fs from 'node:fs';
import path from 'node:path';
import * as core from '@actions/core';
import { renderQualitySummary } from './summary.js';

const canonicalPath = (value: string): string => {
  const absolute = path.resolve(value);
  const suffix: string[] = [];
  let current = absolute;
  while (true) {
    try {
      const resolved = fs.realpathSync.native(current);
      return path.join(resolved, ...suffix);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
        throw new Error('ci-summary-path-invalid');
      }
      const parent = path.dirname(current);
      if (parent === current) throw new Error('ci-summary-path-invalid');
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
};

const sameFile = (left: string, right: string): boolean => {
  if (canonicalPath(left) === canonicalPath(right)) return true;
  try {
    const leftStat = fs.statSync(left);
    const rightStat = fs.statSync(right);
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw new Error('ci-summary-path-invalid');
  }
};

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
    if (sameFile(outputPath, evidencePath)) {
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
