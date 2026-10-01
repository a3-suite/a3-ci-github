import fs from 'node:fs';
import { GithubPublisherClient, publishRelease } from './publisher';
import { fail, text, releaseErrorMessage } from '../../../runtime/release-publication/io';

const input = (name: string): string => text(process.env[`INPUT_${name.toUpperCase()}`], `input-invalid:${name}`);
export const run = async (): Promise<void> => {
  try {
    const output = text(process.env.GITHUB_OUTPUT, 'output-path-invalid');
    const token = text(process.env.GH_TOKEN, 'credential-missing');
    const options = { authorityPath: input('authority-path'), handoffRoot: input('release-handoff-root'), beforePath: input('pre-observation-path'),
      outputRoot: input('write-output-directory'), repository: text(process.env.GITHUB_REPOSITORY, 'repository-missing') };
    const result = await publishRelease(options, new GithubPublisherClient(token));
    fs.appendFileSync(output, `receipt-path=${result.receiptPath}\nreadback-path=${result.readbackPath}\n`, 'utf8');
  } catch (error: unknown) {
    process.stderr.write(`${releaseErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
};
if (process.env.GITHUB_ACTIONS === 'true') void run();
