import { completeFailure, DiagnosticError, FailureContext, writeFailureOutputs, safeErrorReason, readActionInput } from '../../../runtime/diagnostics/failure.mjs';
import * as core from '@actions/core';
import { runControl, type ControlInput } from '../../../runtime/release-publication/control.js';

const names = ['release-request-run-id', 'request-workflow-run-id', 'request-head-sha', 'release-identity', 'release-version', 'target-identity', 'release-notes', 'approval-id', 'approval-expires-at', 'approval-body-sha256'] as const;
// Provenance verification runs inside ci-release-authority, so this Action exposes only the workflow-facing operations.
const operations = ['create-request', 'verify-publication-request', 'verify-approval'];
const camel = (name: string): string => name.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());

export const run = (): void => {
  const diagnostic = new FailureContext('ci-release-publication-control', 'release-publication-control');
  try {
    diagnostic.at('control-input', {"input": "operation-and-request-identity"});
    const input = { operation: readActionInput(core.getInput, 'operation', { required: true }), rootDirectory: readActionInput(core.getInput, 'root-directory', { required: true }) } as ControlInput;
    if (!operations.includes(input.operation)) throw new DiagnosticError('release-publication-operation-invalid');
    for (const name of names) input[camel(name)] = readActionInput(core.getInput, name, {
      trimWhitespace: name !== 'release-notes',
    });
    diagnostic.confirmed();
    diagnostic.at('control-operation', {"input": "request-identity-and-approval"});
    const result = runControl(input);
    diagnostic.confirmed();
    diagnostic.at('output-write', {"output": "GITHUB_OUTPUT"});
    diagnostic.writeState = 'write-may-be-partial';
    core.setOutput('status', 'success');
    core.setOutput('request-run-id', result.requestRunId ?? '');
  } catch (error) {
    diagnostic.report(error);
    writeFailureOutputs(core.setOutput, [['status', 'failed']], diagnostic);
    completeFailure(safeErrorReason(error), 1, core.setFailed);
  }
};

if (process.env.GITHUB_ACTIONS === 'true') run();
