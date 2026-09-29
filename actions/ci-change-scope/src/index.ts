import * as core from '@actions/core';
import { createDocsOnlyMatcher, detectChangeScope, determineBaseSha, isCommitSha, runGitDiff } from './scope.js';

const lines = (values: string[]): string => values.join('\n');

export const run = (): void => {
  try {
    const base = determineBaseSha(core.getInput('base-sha'), core.getInput('event-name'), core.getInput('pr-base-sha'), core.getInput('before-sha'));
    const head = core.getInput('head-sha');
    const patterns = core.getInput('docs-only-patterns').split(',').map((value) => value.trim()).filter(Boolean);
    const result = isCommitSha(base) && isCommitSha(head)
      ? detectChangeScope(base, head, createDocsOnlyMatcher(patterns), runGitDiff)
      : detectChangeScope('', '', createDocsOnlyMatcher(patterns), runGitDiff);
    core.setOutput('status', result.status);
    core.setOutput('run-ci', String(result.runCi));
    core.setOutput('run-docs', String(result.runDocs));
    core.setOutput('files', lines(result.files));
    core.setOutput('docs-files', lines(result.docsFiles));
    core.setOutput('other-files', lines(result.otherFiles));
  } catch (error) {
    core.setOutput('status', 'failed');
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
};

if (process.env.GITHUB_ACTIONS === 'true') run();
