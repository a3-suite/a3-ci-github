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
  try {
    const outputPath = process.env.GITHUB_OUTPUT;
    if (!outputPath || /[\0\r\n]/.test(outputPath)) fail('output-path-invalid');
    const options = { authorityPath: input('authority-path'), repository: input('repository'), handoffRoot: input('handoff-root', false) };
    const client = new GithubReadOnlyClient(process.env.GH_TOKEN);
    const operation = input('operation', false);
    let outputs: Record<string, string>;
    if (operation === 'observe-before') {
      const filename = input('observation-path');
      const before = await observeBefore(options, client);
      saveObservation(filename, before);
      outputs = { status: 'success', 'observation-path': filename, 'observation-digest': sha256(readBytes(filename)) };
    } else if (operation === 'verify-after') {
      const result = await verifyAfter({ ...options, receiptPath: input('receipt-path'), readbackPath: input('readback-path'), beforePath: input('observation-path') }, client);
      outputs = { status: 'success', 'release-remote-identity': result.receipt.release_id, 'publish-receipt': JSON.stringify(result.receipt), 'readback-evidence': JSON.stringify(result.evidence) };
    } else fail('operation-invalid');
    fs.appendFileSync(outputPath, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''), 'utf8');
  } catch (error: unknown) {
    process.stderr.write(`${releaseErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
};
if (process.env.GITHUB_ACTIONS === 'true') void run();
