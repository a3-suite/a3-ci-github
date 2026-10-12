import { completeFailure, FailureContext, writeFailureOutputs, safeErrorReason, readActionInput, DiagnosticError } from '../../../runtime/diagnostics/failure.mjs';
import * as core from '@actions/core';
import { createDocsOnlyMatcher, detectChangeScope, determineBaseSha, isCommitSha, runGitDiff } from './scope.js';

const lines = (values: string[]): string => values.join('\n');

export const run = (): void => {
  const diagnostic = new FailureContext('ci-change-scope', 'change-scope');
  try {
    diagnostic.at('range-resolution', {"input": "base-head-event"});
    const base = determineBaseSha(readActionInput(core.getInput, 'base-sha'), readActionInput(core.getInput, 'event-name'), readActionInput(core.getInput, 'pr-base-sha'), readActionInput(core.getInput, 'before-sha'));
    const head = readActionInput(core.getInput, 'head-sha');
    const patterns = readActionInput(core.getInput, 'docs-only-patterns').split(',').map((value) => value.trim()).filter(Boolean);
    diagnostic.confirmed();
    diagnostic.at('git-diff', {"input": "base-head-and-doc-patterns"});
    const result = isCommitSha(base) && isCommitSha(head)
      ? detectChangeScope(base, head, createDocsOnlyMatcher(patterns), runGitDiff)
      : detectChangeScope('', '', createDocsOnlyMatcher(patterns), runGitDiff);
    if (result.status === 'unresolved') {
      diagnostic.outcome = 'unresolved';
      diagnostic.at('git-diff', { base: isCommitSha(base) ? base : 'unavailable', head: isCommitSha(head) ? head : 'unavailable', runCi: result.runCi, runDocs: result.runDocs });
      diagnostic.report(new DiagnosticError(isCommitSha(base) && isCommitSha(head) ? 'git-diff-unavailable' : 'change-range-unavailable'));
    }
    diagnostic.confirmed();
    diagnostic.at('output-write', {"output": "GITHUB_OUTPUT"});
    diagnostic.writeState = 'write-may-be-partial';
    core.setOutput('status', result.status);
    core.setOutput('run-ci', String(result.runCi));
    core.setOutput('run-docs', String(result.runDocs));
    core.setOutput('files', lines(result.files));
    core.setOutput('docs-files', lines(result.docsFiles));
    core.setOutput('other-files', lines(result.otherFiles));
  } catch (error) {
    diagnostic.report(error);
    writeFailureOutputs(core.setOutput, [['status', 'failed']], diagnostic);
    completeFailure(safeErrorReason(error), 1, core.setFailed);
  }
};

if (process.env.GITHUB_ACTIONS === 'true') run();
