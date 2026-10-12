import { completeFailure, FailureContext } from '../../../runtime/diagnostics/failure.mjs';
import fs from 'node:fs';
import { GithubPublisherClient, publishRelease } from './publisher';
import { fail, text, releaseErrorMessage } from '../../../runtime/release-publication/io';

const input = (name: string): string => text(process.env[`INPUT_${name.toUpperCase()}`], `input-invalid:${name}`);
export const run = async (): Promise<void> => {
  const diagnostic = new FailureContext('ci-release-publisher', 'release-publisher');
  try {
    const output = text(process.env.GITHUB_OUTPUT, 'output-path-invalid');
    const token = text(process.env.GH_TOKEN, 'credential-missing');
    diagnostic.confirmed();
    diagnostic.at('publication-input', {"input": "authority-handoff-pre-observation"});
    const options = { authorityPath: input('authority-path'), handoffRoot: input('release-handoff-root'), beforePath: input('pre-observation-path'),
      outputRoot: input('write-output-directory'), repository: text(process.env.GITHUB_REPOSITORY, 'repository-missing') };
    diagnostic.confirmed();
    diagnostic.at('publication-transaction', {"input": "authority-handoff-pre-observation"});
    const result = await publishRelease(options, new GithubPublisherClient(token));
    diagnostic.retainedEvidence = 'configured-write-output-directory/receipt.json-and-readback.json';
    diagnostic.confirmed();
    diagnostic.at('output-write', {"output": "GITHUB_OUTPUT"});
    diagnostic.writeState = 'write-may-be-partial';
    fs.appendFileSync(output, `receipt-path=${result.receiptPath}\nreadback-path=${result.readbackPath}\n`, 'utf8');
  } catch (error: unknown) {
    diagnostic.report(error);
    completeFailure(releaseErrorMessage(error), 1);
  }
};
if (process.env.GITHUB_ACTIONS === 'true') void run();
