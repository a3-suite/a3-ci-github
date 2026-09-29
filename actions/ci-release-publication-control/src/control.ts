import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type ControlInput = Record<string, string> & { operation: string; rootDirectory: string };
export type ControlResult = { requestRunId?: string };

const sha256 = (value: crypto.BinaryLike): string => crypto.createHash('sha256').update(value).digest('hex');
const scalar = (input: ControlInput, name: string): string => {
  const value = input[name] ?? '';
  if (!value || /[\0\r\n]/.test(value)) throw new Error(`release-publication-${name}-invalid`);
  return value;
};
const readJson = (file: string): Record<string, any> => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>;

export const parseFutureRfc3339 = (value: string, now = Date.now()): number => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) throw new Error('approval expiry is not a valid RFC 3339 timestamp');
  const [, y, mo, d, h, mi, s, fraction = '', zone, sign, oh = '0', om = '0'] = match;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = [y, mo, d, h, mi, s, oh, om].map(Number);
  if (year === 0 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 60 || offsetHour > 23 || offsetMinute > 59) throw new Error('approval expiry is not a valid RFC 3339 timestamp');
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, Math.min(second, 59), Number((fraction + '000').slice(0, 3)));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day || calendar.getUTCHours() !== hour || calendar.getUTCMinutes() !== minute || calendar.getUTCSeconds() !== Math.min(second, 59)) throw new Error('approval expiry is not a valid RFC 3339 timestamp');
  const offset = zone === 'Z' ? 0 : (offsetHour * 60 + offsetMinute) * (sign === '+' ? 1 : -1);
  const base = calendar.getTime() - offset * 60_000;
  if (second === 60) {
    const utc = new Date(base);
    if (utc.getUTCHours() !== 23 || utc.getUTCMinutes() !== 59 || !((utc.getUTCMonth() === 5 && utc.getUTCDate() === 30) || (utc.getUTCMonth() === 11 && utc.getUTCDate() === 31))) throw new Error('approval expiry is not a valid RFC 3339 timestamp');
  }
  const epoch = base + (second === 60 ? 1000 : 0);
  if (!Number.isFinite(epoch) || epoch <= now) throw new Error('approval is expired');
  return epoch;
};

const rootPath = (input: ControlInput, ...parts: string[]): string => path.join(path.resolve(input.rootDirectory), ...parts);
const verifySidecar = (input: ControlInput, directory: string, filename: string, sidecar: string): Buffer => {
  const content = fs.readFileSync(rootPath(input, directory, filename));
  const digest = fs.readFileSync(rootPath(input, directory, sidecar), 'utf8');
  const match = /^([a-f0-9]{64})  ([^\r\n]+)\n?$/.exec(digest);
  if (!match || match[2] !== filename || match[1] !== sha256(content)) throw new Error(`${filename} digest mismatch`);
  return content;
};

const createRequest = (input: ControlInput): ControlResult => {
  const releaseRequestRunId = scalar(input, 'releaseRequestRunId');
  const workflowRunId = scalar(input, 'requestWorkflowRunId');
  const workflowHeadSha = scalar(input, 'requestHeadSha');
  const releaseIdentity = scalar(input, 'releaseIdentity');
  const approvalId = scalar(input, 'approvalId');
  const approvalExpiresAt = scalar(input, 'approvalExpiresAt');
  const approvedBodySha256 = scalar(input, 'approvalBodySha256');
  const releaseNotes = input.releaseNotes ?? '';
  if (!/^[1-9][0-9]*$/.test(releaseRequestRunId) || !/^[1-9][0-9]*$/.test(workflowRunId)) throw new Error('run IDs must be positive integers');
  if (!/^[a-f0-9]{40}$/.test(workflowHeadSha)) throw new Error('request head SHA is invalid');
  if (!releaseNotes || /\0/.test(releaseNotes)) throw new Error('release notes are missing or invalid');
  if (!/^[a-f0-9]{64}$/.test(approvedBodySha256)) throw new Error('approved body SHA-256 is invalid');
  parseFutureRfc3339(approvalExpiresAt);
  const bodySha256 = sha256(releaseNotes);
  if (bodySha256 !== approvedBodySha256) throw new Error('release notes do not match the approved body digest');
  const request = { schema: 'ci.release-publication-request.v1', workflowRunId, workflowHeadSha, releaseRequestRunId, releaseIdentity, releaseNotesBodySha256: bodySha256, approvalId, approvalExpiresAt };
  const requestDir = rootPath(input, 'release-publication-request');
  const notesDir = rootPath(input, 'release-notes-handoff');
  fs.mkdirSync(requestDir, { recursive: true });
  fs.mkdirSync(notesDir, { recursive: true });
  const json = `${JSON.stringify(request)}\n`;
  fs.writeFileSync(path.join(requestDir, 'request.json'), json);
  fs.writeFileSync(path.join(requestDir, 'request.json.sha256'), `${sha256(json)}  request.json\n`);
  fs.writeFileSync(path.join(notesDir, 'release-notes.json'), `${JSON.stringify({ schema: 'ci.release-notes.v1', source_contract: 'git.release-flow', source_field: 'body', release_identity: releaseIdentity, body: releaseNotes, body_sha256: bodySha256 })}\n`);
  fs.writeFileSync(path.join(notesDir, 'release-notes-approval.json'), `${JSON.stringify({ schema: 'ci.release-notes-approval.v1', source_contract: 'git.release-flow', source_field: 'body', release_identity: releaseIdentity, body_sha256: bodySha256, approval_id: approvalId })}\n`);
  return {};
};

const verifyPublicationRequest = (input: ControlInput): ControlResult => {
  const request = JSON.parse(verifySidecar(input, 'release-publication-request', 'request.json', 'request.json.sha256').toString('utf8')) as Record<string, unknown>;
  const fields = ['workflowRunId', 'workflowHeadSha', 'releaseRequestRunId', 'releaseIdentity', 'releaseNotesBodySha256', 'approvalId', 'approvalExpiresAt'];
  if (request.schema !== 'ci.release-publication-request.v1' || fields.some((name) => typeof request[name] !== 'string' || !request[name])) throw new Error('request schema is invalid');
  if (request.workflowRunId !== scalar(input, 'requestWorkflowRunId')) throw new Error('request run ID is not bound to workflow_run');
  if (request.workflowHeadSha !== scalar(input, 'requestHeadSha')) throw new Error('request head SHA is not bound to workflow_run');
  if (!/^[1-9][0-9]*$/.test(String(request.releaseRequestRunId))) throw new Error('release request run ID is invalid');
  if (!/^[a-f0-9]{64}$/.test(String(request.releaseNotesBodySha256))) throw new Error('release notes body digest is invalid');
  return { requestRunId: String(request.releaseRequestRunId) };
};

const verifyProvenance = (input: ControlInput): ControlResult => {
  const publicationRun = readJson(rootPath(input, 'run-metadata/publication-request.json'));
  const releaseRun = readJson(rootPath(input, 'run-metadata/release-request.json'));
  const publicationRequest = JSON.parse(verifySidecar(input, 'release-publication-request', 'request.json', 'request.json.sha256').toString('utf8'));
  const releaseRequest = JSON.parse(verifySidecar(input, 'release-request', 'release-request.json', 'release-request.json.sha256').toString('utf8'));
  const notes = readJson(rootPath(input, 'release-notes-handoff/release-notes.json'));
  const approval = readJson(rootPath(input, 'release-notes-handoff/release-notes-approval.json'));
  const publicationRunId = scalar(input, 'publicationRequestRunId');
  const releaseRunId = scalar(input, 'releaseRequestRunId');
  const approvalId = scalar(input, 'approvalId');
  const approvedBodySha256 = scalar(input, 'approvalBodySha256');
  if (publicationRequest.schema !== 'ci.release-publication-request.v1') throw new Error('publication request schema is invalid');
  if (publicationRequest.workflowRunId !== publicationRunId || publicationRequest.workflowRunId !== String(publicationRun.id)) throw new Error('publication request run ID mismatch');
  if (publicationRequest.workflowHeadSha !== publicationRun.head_sha) throw new Error('publication request head SHA mismatch');
  if (publicationRequest.releaseRequestRunId !== releaseRunId || releaseRequest.request_run_id !== releaseRunId) throw new Error('release request run ID mismatch');
  if (releaseRequest.schema !== 'ci.release-request.v1' || !/^[a-f0-9]{40}$/.test(releaseRequest.source_sha)) throw new Error('release request schema is invalid');
  if (releaseRequest.event !== 'tag') throw new Error('release request event is invalid');
  const expectedName = scalar(input, 'releaseRequestTagWorkflowName');
  const expectedPath = scalar(input, 'releaseRequestTagWorkflowPath');
  const releaseRunPath = typeof releaseRun.path === 'string' ? releaseRun.path.split('@', 1)[0] : '';
  if (releaseRun.name !== expectedName || releaseRunPath !== expectedPath || releaseRun.event !== 'push') throw new Error('release request workflow provenance is invalid');
  if (releaseRequest.ref !== `refs/tags/${releaseRequest.tag}` || releaseRun.head_sha !== releaseRequest.source_sha) throw new Error('tag request source provenance is invalid');
  const body = notes.body;
  if (notes.schema !== 'ci.release-notes.v1' || notes.source_contract !== 'git.release-flow' || notes.source_field !== 'body' || typeof body !== 'string' || !body) throw new Error('release notes schema is invalid');
  const bodySha256 = sha256(body);
  if (bodySha256 !== notes.body_sha256 || bodySha256 !== approval.body_sha256 || bodySha256 !== publicationRequest.releaseNotesBodySha256 || bodySha256 !== approvedBodySha256) throw new Error('release notes body digest mismatch');
  if (approval.schema !== 'ci.release-notes-approval.v1' || approval.source_contract !== 'git.release-flow' || approval.source_field !== 'body') throw new Error('release notes approval schema is invalid');
  if (notes.release_identity !== publicationRequest.releaseIdentity || approval.release_identity !== publicationRequest.releaseIdentity || releaseRequest.tag !== publicationRequest.releaseIdentity) throw new Error('release identity mismatch');
  if (approval.approval_id !== publicationRequest.approvalId || approval.approval_id !== approvalId) throw new Error('approval ID mismatch');
  parseFutureRfc3339(publicationRequest.approvalExpiresAt);
  return {};
};

const verifyApproval = (input: ControlInput): ControlResult => {
  const request = readJson(rootPath(input, 'authority/publication-request.json'));
  parseFutureRfc3339(request.approvalExpiresAt);
  if (request.approvalId !== scalar(input, 'approvalId')) throw new Error('approval ID changed before publication');
  if (request.releaseNotesBodySha256 !== scalar(input, 'approvalBodySha256')) throw new Error('approved body digest changed before publication');
  return {};
};

export const runControl = (input: ControlInput): ControlResult => {
  if (input.operation === 'create-request') return createRequest(input);
  if (input.operation === 'verify-publication-request') return verifyPublicationRequest(input);
  if (input.operation === 'verify-provenance') return verifyProvenance(input);
  if (input.operation === 'verify-approval') return verifyApproval(input);
  throw new Error('release-publication-operation-invalid');
};
