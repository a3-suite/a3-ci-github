import fs from 'node:fs';
import path from 'node:path';
import { runSupplemental } from '../../../runtime/release-publication/supplemental';
import { fail, releaseErrorMessage } from '../../../runtime/release-publication/io';

const input = (name: string, required = true): string => {
  const value = process.env[`INPUT_${name.toUpperCase()}`] ?? '';
  if (required && !value) fail(`input-missing:${name}`);
  if (/[\0\r\n]/.test(value)) fail(`input-invalid:${name}`);
  return value;
};
export const run = (): void => {
  try {
    const outputPath = process.env.GITHUB_OUTPUT;
    if (!outputPath || /[\0\r\n]/.test(outputPath)) fail('output-path-invalid');
    const outputDirectory = input('output-directory');
    runSupplemental({
      operation: input('operation'), sourceRoot: input('source-root', false) || '.',
      authorityPath: input('authority-path'), snapshotPath: input('snapshot-path'),
      standardBuildRoot: input('standard-build-root'), supplementalBuildRoot: input('supplemental-build-root', false),
      outputDirectory,
      installerRoot: fs.existsSync(path.join(__dirname, 'installer')) ? path.join(__dirname, 'installer') : path.resolve(__dirname, '../../../runtime/installer'),
    });
    fs.appendFileSync(outputPath, `status=success\noutput-directory=${outputDirectory}\n`, 'utf8');
  } catch (error: unknown) {
    process.stderr.write(`${releaseErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
};
if (process.env.GITHUB_ACTIONS === 'true') run();
