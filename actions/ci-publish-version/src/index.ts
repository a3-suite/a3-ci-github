import { completeFailure, FailureContext, writeFailureOutputs, safeErrorReason, readActionInput, DiagnosticError } from '../../../runtime/diagnostics/failure.mjs';
import fs from 'node:fs';
import * as core from '@actions/core';
import { materializePublishVersion } from './materialize.js';

const readPlan = (planPath: string): unknown => {
  if (!planPath || /[\0\r\n]/.test(planPath)) throw new DiagnosticError('publish-version-plan-path-invalid');
  let raw: string;
  try {
    raw = fs.readFileSync(planPath, 'utf8');
  } catch {
    throw new DiagnosticError('publish-version-plan-json-invalid');
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new DiagnosticError('publish-version-plan-json-invalid');
  }
};

export const run = (): void => {
  const diagnostic = new FailureContext('ci-publish-version', 'publish-version');
  try {
    diagnostic.at('plan-read', {"input": "version-plan-json"});
    const plan = readPlan(readActionInput(core.getInput, 'version-plan-json', { required: true }));
    diagnostic.confirmed();
    diagnostic.at('version-materialization', {"input": "version-plan-json"});
    const publishVersion = materializePublishVersion(plan);
    diagnostic.confirmed();
    diagnostic.at('output-write', {"output": "GITHUB_OUTPUT"});
    diagnostic.writeState = 'write-may-be-partial';
    core.setOutput('status', 'success');
    core.setOutput('publish-version', publishVersion);
  } catch (error) {
    diagnostic.report(error);
    writeFailureOutputs(core.setOutput, [['status', 'failed']], diagnostic);
    completeFailure(safeErrorReason(error), 1, core.setFailed);
  }
};

if (process.env.GITHUB_ACTIONS === 'true') run();
