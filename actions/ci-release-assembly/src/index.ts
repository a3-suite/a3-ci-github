import fs from 'node:fs';
import { decodePlatformManifest } from './platform-manifest-decoder';
import { assembleRelease } from '../../../runtime/release-publication/assembly';
import { fail, releaseErrorMessage } from '../../../runtime/release-publication/io';

const input = (name: string, required = true): string => {
  const value = process.env[`INPUT_${name.toUpperCase()}`] ?? '';
  if (required && !value) fail(`input-missing:${name}`);
  if (name !== 'platform-matrix' && /[\0\r\n]/.test(value)) fail(`input-invalid:${name}`);
  return value;
};
export const run = async (): Promise<void> => {
  try {
    const outputPath = process.env.GITHUB_OUTPUT;
    if (!outputPath || /[\0\r\n]/.test(outputPath)) fail('output-path-invalid');
    const outputRoot = input('output-directory');
    const assembly = assembleRelease({
      repository: input('repository'), authorityPath: input('authority-path'), snapshotPath: input('snapshot-path'),
      platformManifestPath: input('platform-manifest-path'), platformMatrix: input('platform-matrix'),
      buildRoot: input('build-root'), supplementalRoot: input('supplemental-root', false), outputRoot,
    }, decodePlatformManifest);
    const outputs = { status: 'success', 'release-handoff': outputRoot, 'asset-digest': assembly.asset_digest };
    fs.appendFileSync(outputPath, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''), 'utf8');
  } catch (error: unknown) {
    process.stderr.write(`${releaseErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
};
if (process.env.GITHUB_ACTIONS === 'true') void run();
