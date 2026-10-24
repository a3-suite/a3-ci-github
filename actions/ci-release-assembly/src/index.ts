import { completeFailure, FailureContext } from '../../../runtime/diagnostics/failure.mjs';
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
  const diagnostic = new FailureContext('ci-release-assembly', 'release-assembly');
  try {
    const outputPath = process.env.GITHUB_OUTPUT;
    if (!outputPath || /[\0\r\n]/.test(outputPath)) fail('output-path-invalid');
    const outputRoot = input('output-directory');
    diagnostic.confirmed();
    diagnostic.at('assembly-validation', {"input": "authority-snapshot-platform-build-and-supplemental"});
    const assembly = assembleRelease({
      repository: input('repository'), authorityPath: input('authority-path'), snapshotPath: input('snapshot-path'),
      platformManifestPath: input('platform-manifest-path', false), platformMatrix: input('platform-matrix', false),
      buildRoot: input('build-root', false), supplementalRoot: input('supplemental-root', false), skillsSourceRoot: input('skills-source-root', false), outputRoot,
    }, decodePlatformManifest);
    diagnostic.retainedEvidence = 'configured-output-directory/assembly.json';
    const outputs = { status: 'success', 'release-handoff': outputRoot, 'asset-digest': assembly.asset_digest };
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
