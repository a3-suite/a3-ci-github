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
  if (!value || /[\0\r\n]/.test(value)) throw new Error(error);
  return value;
};

const safePath = (value: string): string => {
  const resolved = path.resolve(required(value, 'output-directory-required'));
  if (resolved === path.parse(resolved).root) throw new Error('output-directory-invalid');
  return resolved;
};

const sha = (value: string, error: string): string => {
  if (!SHA.test(value)) throw new Error(error);
  return value;
};

const writeJson = (filePath: string, value: unknown): void => {
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
};

export const writeReleaseRequestHandoff = (input: HandoffInput): HandoffResult => {
  const outputDirectory = safePath(input.outputDirectory);
  fs.mkdirSync(outputDirectory, { recursive: true });
  const tagSourceSha = sha(required(input.tagSourceSha, 'tag-source-sha-required'), 'tag-source-sha-invalid');
  const tagObjectSha = sha(required(input.tagObjectSha, 'tag-object-sha-required'), 'tag-object-sha-invalid');
  const requestPath = path.join(outputDirectory, 'release-request.json');
  const tag = required(input.githubRefName, 'github-ref-name-required');
  const githubRef = required(input.githubRef, 'github-ref-required');
  if (githubRef !== `refs/tags/${tag}`) throw new Error('github-tag-ref-mismatch');
  const requestRunId = required(input.requestRunId, 'request-run-id-required');
  if (!/^[1-9][0-9]*$/.test(requestRunId)) throw new Error('request-run-id-invalid');
  const common = {
    source_sha: tagSourceSha,
    tag_object_sha: tagObjectSha,
    tag_object_type: 'tag',
    request_run_id: requestRunId,
    request_actor: required(input.requestActor, 'request-actor-required'),
  };
  writeJson(requestPath, { schema: 'ci.release-request.v1', event: 'tag', ref: githubRef, tag, version: null, version_resolution: 'authority', ...common });
  const requestDigestPath = `${requestPath}.sha256`;
  const requestDigest = crypto.createHash('sha256').update(fs.readFileSync(requestPath)).digest('hex');
  fs.writeFileSync(requestDigestPath, `${requestDigest}  release-request.json\n`, 'utf8');
  return { requestPath, requestDigestPath };
};
