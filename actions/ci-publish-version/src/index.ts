import fs from 'node:fs';
import * as core from '@actions/core';
import { materializePublishVersion } from './materialize.js';

const readPlan = (planPath: string): unknown => {
  if (!planPath || /[\0\r\n]/.test(planPath)) throw new Error('publish-version-plan-path-invalid');
  let raw: string;
  try {
    raw = fs.readFileSync(planPath, 'utf8');
  } catch {
    throw new Error('publish-version-plan-json-invalid');
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('publish-version-plan-json-invalid');
  }
};

export const run = (): void => {
  try {
    const plan = readPlan(core.getInput('version-plan-json', { required: true }));
    const publishVersion = materializePublishVersion(plan);
    core.setOutput('status', 'success');
    core.setOutput('publish-version', publishVersion);
  } catch (error) {
    core.setOutput('status', 'failed');
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
};

if (process.env.GITHUB_ACTIONS === 'true') run();
