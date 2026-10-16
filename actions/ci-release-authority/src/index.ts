import { completeFailure, FailureContext } from '../../../runtime/diagnostics/failure.mjs';
import fs from 'node:fs';
import { createAuthority } from './authority';
import { GithubReadOnlyClient } from '../../../runtime/release-publication/observation';
import { text, releaseErrorMessage } from '../../../runtime/release-publication/io';
const input = (name: string): string => text(process.env[`INPUT_${name.toUpperCase()}`], `input-invalid:${name}`);
export const run = async (): Promise<void> => {
  const diagnostic = new FailureContext('ci-release-authority', 'release-authority');
  try {
    const outputPath = text(process.env.GITHUB_OUTPUT);
    diagnostic.confirmed();
    diagnostic.at('authority-validation', {"input": "owner-decision-request-snapshot-and-tag"});
    const result = await createAuthority({ rootDirectory: input('root-directory'), snapshotPath: input('snapshot-path'), outputDirectory: input('output-directory'), repository: text(process.env.GITHUB_REPOSITORY), requestRunId: input('release-request-run-id'), publicationRequestRunId: input('publication-request-run-id') }, new GithubReadOnlyClient(input('github-token')), diagnostic);
    diagnostic.retainedEvidence = 'configured-output-directory/authority.json';
    const outputs = { 'authority-path': result.authorityPath, source_sha: result.sourceSha, version: result.version, target_identity: result.targetIdentity, 'approval-id': result.approvalId, 'body-sha256': result.bodyDigest };
    diagnostic.confirmed();
    diagnostic.at('output-write', {"output": "GITHUB_OUTPUT"});
    diagnostic.writeState = 'write-may-be-partial';
    fs.appendFileSync(outputPath, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''));
  } catch (error: unknown) {
    diagnostic.report(error); completeFailure(releaseErrorMessage(error), 1); }
};
if (process.env.GITHUB_ACTIONS === 'true') void run();
