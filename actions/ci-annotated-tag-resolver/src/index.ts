import { completeFailure, FailureContext, safeErrorReason, readActionInput } from '../../../runtime/diagnostics/failure.mjs';
import * as core from '@actions/core';
import { resolveAnnotatedTag } from './tag.js';

export const run = async (): Promise<void> => {
  const diagnostic = new FailureContext('ci-annotated-tag-resolver', 'annotated-tag-resolver');
  try {
    diagnostic.at('tag-resolution', {"input": "repository-and-annotated-tag"});
    const result = await resolveAnnotatedTag(
      readActionInput(core.getInput, 'repository', { required: true }),
      readActionInput(core.getInput, 'tag', { required: true }),
      readActionInput(core.getInput, 'github-token', { required: true }),
      process.env.GITHUB_API_URL || 'https://api.github.com',
    );
    diagnostic.confirmed();
    diagnostic.at('output-write', {"output": "GITHUB_OUTPUT"});
    diagnostic.writeState = 'write-may-be-partial';
    core.setOutput('tag-object-sha', result.tagObjectSha);
    core.setOutput('tag-object-type', result.tagObjectType);
    core.setOutput('source-sha', result.sourceSha);
  } catch (error) {
    diagnostic.report(error);
    completeFailure(safeErrorReason(error), 1, core.setFailed);
  }
};

if (process.env.GITHUB_ACTIONS === 'true') void run();
