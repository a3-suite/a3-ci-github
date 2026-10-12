import { completeFailure, FailureContext, writeFailureOutputs, safeErrorReason, readActionInput, DiagnosticError } from '../../../runtime/diagnostics/failure.mjs';
import * as core from '@actions/core';
import fs from 'node:fs';
import path from 'node:path';
import { executeAdapter, loadAdapterBundle, parseAdapterBundle } from './adapter.js';
import { isStandardQualityBundle, standardQualityBundle } from '../../../runtime/adapter/standard-quality-bundles.js';

export const run = (): void => {
  const diagnostic = new FailureContext('ci-quality-adapter', 'quality-adapter');
  try {
    diagnostic.at('bundle-selection', {"input": "bundle-path-or-standard-bundle-id"});
    const bundlePath = readActionInput(core.getInput, 'bundle-path');
    const standardId = readActionInput(core.getInput, 'standard-bundle-id');
    if (Boolean(bundlePath) === Boolean(standardId)) throw new DiagnosticError('quality-adapter-bundle-selection-invalid');
    const standard = standardId ? standardQualityBundle(standardId) : undefined;
    diagnostic.confirmed();
    diagnostic.at('bundle-validation', {"input": "selected-bundle"});
    const bundle = standard ? parseAdapterBundle(standard.descriptor) : loadAdapterBundle(path.resolve(bundlePath));
    if (!standard && isStandardQualityBundle(bundle.id)) throw new DiagnosticError('quality-adapter-standard-id-requires-action-bundle');
    if (standard && (bundle.id !== standard.id || bundle.owner !== standard.owner || bundle.assets.length !== 0)) {
      throw new DiagnosticError('quality-adapter-standard-bundle-metadata-invalid');
    }
    const resultPath = path.resolve(readActionInput(core.getInput, 'result-path', { required: true }));
    diagnostic.confirmed();
    diagnostic.at('adapter-execution', {"input": "selected-bundle-and-source-root"});
    diagnostic.details.bundle = /^[A-Za-z0-9_.-]{1,100}$/.test(bundle.id) ? bundle.id : 'protected-or-invalid';
    const payload = executeAdapter(bundle, {
      sourceRoot: path.resolve(readActionInput(core.getInput, 'source-root', { required: true })),
      languageProfile: readActionInput(core.getInput, 'language-profile') || undefined,
      toolchainVersion: readActionInput(core.getInput, 'toolchain-version', { required: true }),
      requireTrustedProjectScripts: core.getBooleanInput('require-trusted-project-scripts'),
      trustedProjectRoot: readActionInput(core.getInput, 'trusted-project-root') || undefined,
    });
    diagnostic.confirmed();
    diagnostic.at('result-write', {"output": "result-path"});
    diagnostic.writeState = 'write-may-be-partial';
    fs.mkdirSync(path.dirname(resultPath), { recursive: true });
    const publicPayload = { ...payload, results: payload.results.map(result => ({
      ...result,
      id: /^[A-Za-z0-9_.-]{1,100}$/.test(result.id) ? result.id : 'protected-or-invalid',
      command: /^[A-Za-z0-9_.-]{1,100}$/.test(result.command) ? result.command : 'protected-command',
      ...(result.args ? { args: result.args.map(() => 'protected-argument') } : {}),
      stdout: result.stdout ? 'protected-child-output' : '',
      stderr: result.stderr ? 'protected-child-output' : '',
    })) };
    const resultJson = `${JSON.stringify(publicPayload, null, 2)}\n`;
    fs.writeFileSync(resultPath, resultJson, 'utf8');
    diagnostic.retainedEvidence = 'configured-result-path';
    diagnostic.confirmed();
    diagnostic.at('output-write', {"output": "GITHUB_OUTPUT"});
    diagnostic.writeState = 'write-may-be-partial';
    core.setOutput('status', payload.status);
    core.setOutput('result-path', resultPath);
    process.stdout.write(resultJson);
    if (payload.status !== 'success') {
      diagnostic.outcome = payload.status === '判定不能' ? 'unresolved' : 'failed';
      diagnostic.at('adapter-result', { input: 'selected-bundle-and-source-root', evidence: 'result-path' });
      diagnostic.report(new DiagnosticError(`quality-adapter-${diagnostic.outcome}`, { diagnostics: { field: 'adapter-status', expected: 'success', observed: payload.status, tasks: payload.results.map(result => ({ id: /^[A-Za-z0-9_.-]{1,100}$/.test(result.id) ? result.id : 'unavailable', status: result.status, exit: result.exitCode })) } }));
      completeFailure(`quality-adapter-${payload.status}`, 1, core.setFailed);
    }
  } catch (error) {
    diagnostic.report(error);
    writeFailureOutputs(core.setOutput, [['status', 'failed']], diagnostic);
    completeFailure(safeErrorReason(error), 1, core.setFailed);
  }
};

if (process.env.GITHUB_ACTIONS === 'true') run();
