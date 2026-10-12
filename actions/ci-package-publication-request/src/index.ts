import { completeFailure, FailureContext, writeFailureOutputs, safeErrorReason, readActionInput, DiagnosticError } from '../../../runtime/diagnostics/failure.mjs';
import * as core from '@actions/core';
import { createRequest, verifyRequest, type RequestFields } from './request.js';

export const run = (): void => {
  const diagnostic = new FailureContext('ci-package-publication-request', 'package-publication-request');
  try {
    const operation = readActionInput(core.getInput, 'operation', { required: true });
    const requestPath = readActionInput(core.getInput, 'request-path', { required: true });
    diagnostic.confirmed();
    diagnostic.at('request-selection', {"input": "operation-and-request-path"});
    let result: RequestFields;
    if (operation === 'create') {
    diagnostic.confirmed();
    diagnostic.at('request-create', {"output": "request-path"});
      result = createRequest(requestPath, {
        sourceSha: readActionInput(core.getInput, 'source-sha', { required: true }),
        version: readActionInput(core.getInput, 'version', { required: true }),
        targetIdentity: readActionInput(core.getInput, 'target-identity', { required: true }),
        languageProfile: readActionInput(core.getInput, 'language-profile', { required: true }),
        toolchain: readActionInput(core.getInput, 'toolchain', { required: true }),
      });
    } else if (operation === 'verify') {
    diagnostic.confirmed();
    diagnostic.at('request-verify', {"input": "request-path-and-expected-source-sha"});
      result = verifyRequest(requestPath, readActionInput(core.getInput, 'expected-source-sha', { required: true }));
    } else {
      throw new DiagnosticError('package-publication-operation-invalid');
    }
    diagnostic.confirmed();
    diagnostic.at('output-write', {"output": "GITHUB_OUTPUT"});
    diagnostic.writeState = 'write-may-be-partial';
    core.setOutput('status', 'success');
    core.setOutput('request-path', requestPath);
    core.setOutput('source-sha', result.sourceSha);
    core.setOutput('version', result.version);
    core.setOutput('target-identity', result.targetIdentity);
    core.setOutput('language-profile', result.languageProfile);
    core.setOutput('toolchain', result.toolchain);
  } catch (error) {
    diagnostic.report(error);
    writeFailureOutputs(core.setOutput, [['status', 'failed']], diagnostic);
    completeFailure(safeErrorReason(error), 1, core.setFailed);
  }
};

if (process.env.GITHUB_ACTIONS === 'true') run();
