import * as core from '@actions/core';
import { runControl, type ControlInput } from './control.js';

const names = ['release-request-run-id', 'request-workflow-run-id', 'request-head-sha', 'release-identity', 'release-notes', 'approval-id', 'approval-expires-at', 'approval-body-sha256', 'publication-request-run-id', 'release-request-tag-workflow-name', 'release-request-tag-workflow-path'] as const;
const camel = (name: string): string => name.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());

export const run = (): void => {
  try {
    const input = { operation: core.getInput('operation', { required: true }), rootDirectory: core.getInput('root-directory', { required: true }) } as ControlInput;
    for (const name of names) input[camel(name)] = core.getInput(name, {
      trimWhitespace: name !== 'release-notes',
    });
    const result = runControl(input);
    core.setOutput('status', 'success');
    core.setOutput('request-run-id', result.requestRunId ?? '');
  } catch (error) {
    core.setOutput('status', 'failed');
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
};

if (process.env.GITHUB_ACTIONS === 'true') run();
