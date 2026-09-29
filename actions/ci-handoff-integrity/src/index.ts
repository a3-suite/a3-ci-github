import * as core from '@actions/core';
import { validateHandoffIntegrity } from './integrity.js';

export const run = (): void => {
  try {
    const result = validateHandoffIntegrity(
      core.getInput('handoff-root', { required: true }),
      core.getInput('descriptor', { required: true }),
      {
        sourceSha: core.getInput('source-sha', { required: true }),
        version: core.getInput('version', { required: true }),
        targetIdentity: core.getInput('target-identity', { required: true }),
      },
    );
    core.setOutput('status', 'success');
    core.setOutput('descriptor', result.descriptor);
    core.setOutput('manifest', result.manifest);
    core.setOutput('manifest-digest', result.manifestDigest);
    core.setOutput('entries', String(result.entries));
  } catch (error) {
    core.setOutput('status', 'failed');
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
};

if (process.env.GITHUB_ACTIONS === 'true') run();
