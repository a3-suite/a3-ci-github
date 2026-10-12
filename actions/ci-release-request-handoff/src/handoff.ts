import { DiagnosticError, FailureContext } from '../../../runtime/diagnostics/failure.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type HandoffInput = {
  outputDirectory: string;
  tagSourceSha: string;
  tagObjectSha: string;
  githubRef: string;
  githubRefName: string;
  requestRunId: string;
  requestActor: string;
};

export type HandoffResult = {
  requestPath: string;
  requestDigestPath: string;
};

const SHA = /^[0-9a-f]{40}$/;

const required = (value: string | undefined, error: string): string => {
  if (!value || /[\0\r\n]/.test(value)) throw new DiagnosticError(error);
  return value;
};

const safePath = (value: string): string => {
  const resolved = path.resolve(required(value, 'output-directory-required'));
  if (resolved === path.parse(resolved).root) throw new DiagnosticError('output-directory-invalid');
  return resolved;
};

const sha = (value: string, error: string): string => {
  if (!SHA.test(value)) throw new DiagnosticError(error);
  return value;
};

export const writeReleaseRequestHandoff = (input: HandoffInput): HandoffResult => {
  const diagnostic = new FailureContext('ci-release-request-handoff', 'release-request-handoff');
  try {
  diagnostic.at('request-identity-validation', { input: 'tag-ref-source-run' });
  const outputDirectory = safePath(input.outputDirectory);
  const tagSourceSha = sha(required(input.tagSourceSha, 'tag-source-sha-required'), 'tag-source-sha-invalid');
  const tagObjectSha = sha(required(input.tagObjectSha, 'tag-object-sha-required'), 'tag-object-sha-invalid');
  const requestPath = path.join(outputDirectory, 'release-request.json');
  const tag = required(input.githubRefName, 'github-ref-name-required');
  const githubRef = required(input.githubRef, 'github-ref-required');
  if (githubRef !== `refs/tags/${tag}`) throw new DiagnosticError('github-tag-ref-mismatch', { diagnostics: { field: 'github-ref', expected: /^[A-Za-z0-9_.\/-]{1,200}$/.test(tag) ? `refs/tags/${tag}` : 'protected-or-invalid', observed: /^[A-Za-z0-9_.\/-]{1,200}$/.test(githubRef) ? githubRef : 'protected-or-invalid' } });
  const requestRunId = required(input.requestRunId, 'request-run-id-required');
  if (!/^[1-9][0-9]*$/.test(requestRunId)) throw new DiagnosticError('request-run-id-invalid');
  const common = {
    source_sha: tagSourceSha,
    tag_object_sha: tagObjectSha,
    tag_object_type: 'tag',
    request_run_id: requestRunId,
    request_actor: required(input.requestActor, 'request-actor-required'),
  };
  diagnostic.confirmed();
  diagnostic.at('destination-validation', { sourceSha: tagSourceSha, tagObjectSha, requestRunId, output: 'output-directory' });
  const requestDigestPath = `${requestPath}.sha256`;
  if ([requestPath, requestDigestPath].some((file) => fs.lstatSync(file, { throwIfNoEntry: false }))) throw new DiagnosticError('release-request-output-already-exists', { diagnostics: { field: 'request-files', expected: 'absent', observed: 'already-present' } });
  const json = `${JSON.stringify({ schema: 'ci.release-request.v1', event: 'tag', ref: githubRef, tag, version: null, version_resolution: 'authority', ...common })}\n`;
  const requestDigest = crypto.createHash('sha256').update(json).digest('hex');
  diagnostic.confirmed();
  diagnostic.at('request-json-write', { file: 'release-request.json' });
  diagnostic.writeState = 'request-output-may-be-partial';
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.writeFileSync(requestPath, json, { encoding: 'utf8', flag: 'wx' });
  diagnostic.retainedEvidence = 'configured-output-directory/release-request.json';
  diagnostic.confirmed();
  diagnostic.at('request-digest-write', { file: 'release-request.json.sha256' });
  fs.writeFileSync(requestDigestPath, `${requestDigest}  release-request.json\n`, { encoding: 'utf8', flag: 'wx' });
  return { requestPath, requestDigestPath };
  } catch (error) { throw diagnostic.capture(error); }
};
