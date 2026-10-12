import { completeFailure, FailureContext } from '../../../runtime/diagnostics/failure.mjs';
import fs from 'node:fs';
import { GithubReadOnlyClient, observeBefore, verifyAfter, saveObservation } from '../../../runtime/release-publication/observation';
import { sha256, readBytes, fail, releaseErrorMessage } from '../../../runtime/release-publication/io';

const input = (name: string, required = true): string => {
  const value = process.env[`INPUT_${name.toUpperCase()}`] ?? '';
  if (required && !value) fail(`input-missing:${name}`);
  if (/[\0\r\n]/.test(value)) fail(`input-invalid:${name}`);
  return value;
};
export const run = async (): Promise<void> => {
  const diagnostic = new FailureContext('ci-release-publication-verifier', 'release-publication-verifier');
  try {
    const outputPath = process.env.GITHUB_OUTPUT;
    if (!outputPath || /[\0\r\n]/.test(outputPath)) fail('output-path-invalid');
    diagnostic.confirmed();
    diagnostic.at('authority-input', {"input": "authority-path-and-repository"});
    const options = { authorityPath: input('authority-path'), repository: input('repository'), handoffRoot: input('handoff-root', false) };
    const client = new GithubReadOnlyClient(process.env.GH_TOKEN);
    const operation = input('operation', false);
    let outputs: Record<string, string>;
    if (operation === 'observe-before') {
      const filename = input('observation-path');
    diagnostic.confirmed();
    diagnostic.at('remote-observe-before', {"input": "handoff-root"});
      const before = await observeBefore(options, client);
    diagnostic.confirmed();
    diagnostic.at('observation-write', {"output": "observation-path"});
    diagnostic.writeState = 'write-may-be-partial';
      saveObservation(filename, before);
      diagnostic.retainedEvidence = 'configured-observation-path';
      outputs = { status: 'success', 'observation-path': filename, 'observation-digest': sha256(readBytes(filename)) };
    } else if (operation === 'verify-after') {
    diagnostic.confirmed();
    diagnostic.at('remote-verify-after', {"input": "receipt-readback-and-pre-observation"});
      const result = await verifyAfter({ ...options, receiptPath: input('receipt-path'), readbackPath: input('readback-path'), beforePath: input('observation-path') }, client);
      outputs = { status: 'success', 'release-remote-identity': result.receipt.release_id, 'publish-receipt': JSON.stringify(result.receipt), 'readback-evidence': JSON.stringify(result.evidence) };
    } else fail('operation-invalid');
    diagnostic.confirmed();
    diagnostic.at('output-write', {"output": "GITHUB_OUTPUT"});
    diagnostic.writeState = 'write-may-be-partial';
    fs.appendFileSync(outputPath, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''), 'utf8');
  } catch (error: unknown) {
    diagnostic.report(error);
    completeFailure(releaseErrorMessage(error), 1);
  }
};
if (process.env.GITHUB_ACTIONS === 'true') void run();
