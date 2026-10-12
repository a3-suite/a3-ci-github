import { completeFailure, FailureContext, safeErrorReason, readActionInput } from '../../../runtime/diagnostics/failure.mjs';
import * as core from '@actions/core';
import { writeReleaseRequestHandoff } from './handoff.js';

export const run = (): void => {
  const diagnostic = new FailureContext('ci-release-request-handoff', 'release-request-handoff');
  try {
    diagnostic.at('request-write', {"input": "annotated-tag-and-source", "output": "output-directory"});
    const result = writeReleaseRequestHandoff({
      outputDirectory: readActionInput(core.getInput, 'output-directory', { required: true }),
      tagSourceSha: readActionInput(core.getInput, 'tag-source-sha', { required: true }),
      tagObjectSha: readActionInput(core.getInput, 'tag-object-sha', { required: true }),
      githubRef: readActionInput(core.getInput, 'github-ref', { required: true }),
      githubRefName: readActionInput(core.getInput, 'github-ref-name', { required: true }),
      requestRunId: readActionInput(core.getInput, 'request-run-id', { required: true }),
      requestActor: readActionInput(core.getInput, 'request-actor', { required: true }),
    });
    diagnostic.confirmed();
    diagnostic.at('output-write', {"output": "GITHUB_OUTPUT"});
    diagnostic.writeState = 'write-may-be-partial';
    core.setOutput('request-path', result.requestPath);
    core.setOutput('request-digest', result.requestDigestPath);
  } catch (error) {
    diagnostic.report(error);
    completeFailure(safeErrorReason(error), 1, core.setFailed);
  }
};

if (process.env.GITHUB_ACTIONS === 'true') run();
