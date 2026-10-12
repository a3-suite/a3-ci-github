import { completeFailure, FailureContext, writeFailureOutputs, safeErrorReason, readActionInput } from '../../../runtime/diagnostics/failure.mjs';
import * as core from '@actions/core';
import { validateHandoffIntegrity } from './integrity.js';

export const run = (): void => {
  const diagnostic = new FailureContext('ci-handoff-integrity', 'handoff-integrity');
  try {
    diagnostic.at('handoff-verification', {"input": "handoff-root-and-descriptor"});
    const result = validateHandoffIntegrity(
      readActionInput(core.getInput, 'handoff-root', { required: true }),
      readActionInput(core.getInput, 'descriptor', { required: true }),
      {
        sourceSha: readActionInput(core.getInput, 'source-sha', { required: true }),
        version: readActionInput(core.getInput, 'version', { required: true }),
        targetIdentity: readActionInput(core.getInput, 'target-identity', { required: true }),
      },
    );
    diagnostic.confirmed();
    diagnostic.at('output-write', {"output": "GITHUB_OUTPUT"});
    diagnostic.writeState = 'write-may-be-partial';
    core.setOutput('status', 'success');
    core.setOutput('descriptor', result.descriptor);
    core.setOutput('manifest', result.manifest);
    core.setOutput('manifest-digest', result.manifestDigest);
    core.setOutput('entries', String(result.entries));
  } catch (error) {
    diagnostic.report(error);
    writeFailureOutputs(core.setOutput, [['status', 'failed']], diagnostic);
    completeFailure(safeErrorReason(error), 1, core.setFailed);
  }
};

if (process.env.GITHUB_ACTIONS === 'true') run();
