import fs from 'node:fs';
import * as core from '@actions/core';
import { validateReleaseNotesBinding } from './binding.js';

export const run = (): void => {
  try {
    let handoff: unknown;
    let approval: unknown;
    try {
      handoff = JSON.parse(fs.readFileSync(core.getInput('handoff-json', { required: true }), 'utf8'));
      approval = JSON.parse(fs.readFileSync(core.getInput('approval-json', { required: true }), 'utf8'));
    } catch {
      throw new Error('release-notes-json-invalid');
    }
    const result = validateReleaseNotesBinding(handoff, approval, core.getInput('release-identity', { required: true }));
    core.setOutput('status', 'success');
    core.setOutput('release-identity', result.releaseIdentity);
    core.setOutput('digest', result.bodyDigest);
    core.setOutput('approval-id', result.approvalId);
  } catch (error) {
    core.setOutput('status', 'failed');
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
};

if (process.env.GITHUB_ACTIONS === 'true') run();
