import * as core from '@actions/core';
import { writeReleaseRequestHandoff } from './handoff.js';

export const run = (): void => {
  try {
    const result = writeReleaseRequestHandoff({
      outputDirectory: core.getInput('output-directory', { required: true }),
      tagSourceSha: core.getInput('tag-source-sha', { required: true }),
      tagObjectSha: core.getInput('tag-object-sha', { required: true }),
      githubRef: core.getInput('github-ref', { required: true }),
      githubRefName: core.getInput('github-ref-name', { required: true }),
      requestRunId: core.getInput('request-run-id', { required: true }),
      requestActor: core.getInput('request-actor', { required: true }),
    });
    core.setOutput('request-path', result.requestPath);
    core.setOutput('request-digest', result.requestDigestPath);
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
};

if (process.env.GITHUB_ACTIONS === 'true') run();
