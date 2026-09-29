import * as core from '@actions/core';
import { resolveAnnotatedTag } from './tag.js';

export const run = async (): Promise<void> => {
  try {
    const result = await resolveAnnotatedTag(
      core.getInput('repository', { required: true }),
      core.getInput('tag', { required: true }),
      core.getInput('github-token', { required: true }),
      process.env.GITHUB_API_URL || 'https://api.github.com',
    );
    core.setOutput('tag-object-sha', result.tagObjectSha);
    core.setOutput('tag-object-type', result.tagObjectType);
    core.setOutput('source-sha', result.sourceSha);
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
};

if (process.env.GITHUB_ACTIONS === 'true') void run();
