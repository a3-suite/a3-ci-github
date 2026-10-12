import { completeFailure, FailureContext, writeFailureOutputs, safeErrorReason, readActionInput, DiagnosticError } from '../../../runtime/diagnostics/failure.mjs';
import fs from 'node:fs';
import path from 'node:path';
import * as core from '@actions/core';
import { pathsReferToSameFile } from '../../../runtime/path/same-file-core.mjs';
import { resolveConfigSnapshot } from './snapshot.js';

const validatePath = (value: string, error: string): string => {
  if (!value || /[\0\r\n]/.test(value)) throw new DiagnosticError(error);
  return value;
};

export const run = (): void => {
  const diagnostic = new FailureContext('ci-config-snapshot', 'config-snapshot');
  try {
    diagnostic.at('input-validation', {"input": "sources-json"});
    const raw = readActionInput(core.getInput, 'sources-json', { required: true });
    let input: unknown;
    try { input = JSON.parse(raw); } catch { throw new DiagnosticError('config-snapshot-json-invalid'); }
    const snapshotPath = validatePath(readActionInput(core.getInput, 'snapshot-path', { required: true }), 'config-snapshot-path-invalid');
    const commandOutputPath = process.env.GITHUB_OUTPUT;
    const explicitOutputPath = readActionInput(core.getInput, 'output-path');
    const outputPath = explicitOutputPath || commandOutputPath;
    for (const candidate of [explicitOutputPath, commandOutputPath]) {
      if (!candidate) continue;
      validatePath(candidate, 'config-snapshot-output-path-invalid');
      if (pathsReferToSameFile(snapshotPath, candidate, 'config-snapshot-path-invalid')) {
        throw new DiagnosticError('config-snapshot-paths-must-differ');
      }
    }
    diagnostic.confirmed();
    diagnostic.at('snapshot-resolution', {"input": "sources-json"});
    const snapshot = resolveConfigSnapshot(input);
    diagnostic.confirmed();
    diagnostic.at('snapshot-write', {"output": "snapshot-path"});
    diagnostic.writeState = 'write-may-be-partial';
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshot)}\n`, 'utf8');
    diagnostic.retainedEvidence = 'configured-snapshot-path';
    diagnostic.confirmed();
    diagnostic.at('output-write', {"output": "GITHUB_OUTPUT"});
    diagnostic.writeState = 'write-may-be-partial';
    core.setOutput('status', 'success');
    core.setOutput('snapshot-path', snapshotPath);
    core.setOutput('digest', snapshot.digest);
    if (outputPath) {
      fs.appendFileSync(outputPath, `config_snapshot_path=${snapshotPath}\nconfig_snapshot_digest=${snapshot.digest}\n`, 'utf8');
    }
  } catch (error) {
    diagnostic.report(error);
    writeFailureOutputs(core.setOutput, [['status', 'failed']], diagnostic);
    completeFailure(safeErrorReason(error), 1, core.setFailed);
  }
};

if (process.env.GITHUB_ACTIONS === 'true') run();
