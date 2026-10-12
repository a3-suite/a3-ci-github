import { DiagnosticError, FailureContext } from '../diagnostics/failure.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type ControlInput = Record<string, string> & { operation: string; rootDirectory: string };
export type ControlResult = { requestRunId?: string };

const sha256 = (value: crypto.BinaryLike): string => crypto.createHash('sha256').update(value).digest('hex');
const scalar = (input: ControlInput, name: string): string => {
  const value = input[name] ?? '';
  if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value)) throw new DiagnosticError(`release-publication-${name}-invalid`);
  return value;
};
const readJson = (file: string): Record<string, any> => {
  const contents = fs.readFileSync(file, 'utf8');
  try { return JSON.parse(contents) as Record<string, any>; }
  catch (cause) { throw new DiagnosticError('release-publication-json-invalid', { cause, diagnostics: { field: 'declared-json-file', expected: 'json-object', observed: 'invalid-json' } }); }
};

export const parseFutureRfc3339 = (value: string, now = Date.now()): number => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) throw new DiagnosticError('approval expiry is not a valid RFC 3339 timestamp', { diagnosticCode: 'approval-expiry-is-not-a-valid-rfc-3339-timestamp' });
  const [, y, mo, d, h, mi, s, fraction = '', zone, sign, oh = '0', om = '0'] = match;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = [y, mo, d, h, mi, s, oh, om].map(Number);
  if (year === 0 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 60 || offsetHour > 23 || offsetMinute > 59) throw new DiagnosticError('approval expiry is not a valid RFC 3339 timestamp', { diagnosticCode: 'approval-expiry-is-not-a-valid-rfc-3339-timestamp' });
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, Math.min(second, 59), Number((fraction + '000').slice(0, 3)));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day || calendar.getUTCHours() !== hour || calendar.getUTCMinutes() !== minute || calendar.getUTCSeconds() !== Math.min(second, 59)) throw new DiagnosticError('approval expiry is not a valid RFC 3339 timestamp', { diagnosticCode: 'approval-expiry-is-not-a-valid-rfc-3339-timestamp' });
  const offset = zone === 'Z' ? 0 : (offsetHour * 60 + offsetMinute) * (sign === '+' ? 1 : -1);
  const base = calendar.getTime() - offset * 60_000;
  if (second === 60) {
    const utc = new Date(base);
    if (utc.getUTCHours() !== 23 || utc.getUTCMinutes() !== 59 || !((utc.getUTCMonth() === 5 && utc.getUTCDate() === 30) || (utc.getUTCMonth() === 11 && utc.getUTCDate() === 31))) throw new DiagnosticError('approval expiry is not a valid RFC 3339 timestamp', { diagnosticCode: 'approval-expiry-is-not-a-valid-rfc-3339-timestamp' });
  }
  const epoch = base + (second === 60 ? 1000 : 0);
  if (!Number.isFinite(epoch) || epoch <= now) throw new DiagnosticError('approval is expired', { diagnosticCode: 'approval-is-expired' });
  return epoch;
};

const rootPath = (input: ControlInput, ...parts: string[]): string => path.join(path.resolve(input.rootDirectory), ...parts);
const verifySidecar = (input: ControlInput, directory: string, filename: string, sidecar: string): Buffer => {
  const content = fs.readFileSync(rootPath(input, directory, filename));
  const digest = fs.readFileSync(rootPath(input, directory, sidecar), 'utf8');
  const match = /^([a-f0-9]{64})  ([^\r\n]+)\n?$/.exec(digest);
  if (!match || match[2] !== filename || match[1] !== sha256(content)) throw new DiagnosticError(`${filename} digest mismatch`, { diagnosticCode: 'request-file-digest-mismatch', diagnostics: { field: 'sha256', path: filename, expected: match?.[1] ?? 'invalid-sidecar', observed: sha256(content) } });
  return content;
};

const createRequest = (input: ControlInput, diagnostic: FailureContext): ControlResult => {
  const releaseRequestRunId = scalar(input, 'releaseRequestRunId');
  const workflowRunId = scalar(input, 'requestWorkflowRunId');
  const workflowHeadSha = scalar(input, 'requestHeadSha');
  const releaseIdentity = scalar(input, 'releaseIdentity');
  const approvalId = scalar(input, 'approvalId');
  const approvalExpiresAt = scalar(input, 'approvalExpiresAt');
  const approvedBodySha256 = scalar(input, 'approvalBodySha256');
  const releaseNotes = input.releaseNotes ?? '';
  if (!/^[1-9][0-9]*$/.test(releaseRequestRunId) || !/^[1-9][0-9]*$/.test(workflowRunId)) throw new DiagnosticError('run IDs must be positive integers', { diagnosticCode: 'run-ids-must-be-positive-integers' });
  if (!/^[a-f0-9]{40}$/.test(workflowHeadSha)) throw new DiagnosticError('request head SHA is invalid', { diagnosticCode: 'request-head-sha-is-invalid' });
  if (!releaseNotes || /\0/.test(releaseNotes)) throw new DiagnosticError('release notes are missing or invalid', { diagnosticCode: 'release-notes-are-missing-or-invalid' });
  if (!/^[a-f0-9]{64}$/.test(approvedBodySha256)) throw new DiagnosticError('approved body SHA-256 is invalid', { diagnosticCode: 'approved-body-sha-256-is-invalid' });
  parseFutureRfc3339(approvalExpiresAt);
  const bodySha256 = sha256(releaseNotes);
  if (bodySha256 !== approvedBodySha256) throw new DiagnosticError('release notes do not match the approved body digest', { diagnosticCode: 'release-notes-do-not-match-the-approved-body-digest', diagnostics: { field: 'approval-body-sha256', expected: approvedBodySha256, observed: bodySha256 } });
  const decision = publicationDecision(input);
  const request = { schema: 'ci.release-publication-request.v2', ...decision, workflowRunId, workflowHeadSha, releaseRequestRunId, releaseIdentity, releaseNotesBodySha256: bodySha256, approvalId, approvalExpiresAt };
  const requestDir = rootPath(input, 'release-publication-request');
  const notesDir = rootPath(input, 'release-notes-handoff');
  const json = `${JSON.stringify(request)}\n`;
  const files = [
    [path.join(requestDir, 'request.json'), json],
    [path.join(requestDir, 'request.json.sha256'), `${sha256(json)}  request.json\n`],
    [path.join(notesDir, 'release-notes.json'), `${JSON.stringify({ schema: 'ci.release-notes.v1', source_contract: 'git.release-flow', source_field: 'body', release_identity: releaseIdentity, body: releaseNotes, body_sha256: bodySha256 })}\n`],
    [path.join(notesDir, 'release-notes-approval.json'), `${JSON.stringify({ schema: 'ci.release-notes-approval.v1', source_contract: 'git.release-flow', source_field: 'body', release_identity: releaseIdentity, body_sha256: bodySha256, approval_id: approvalId })}\n`],
  ];
  if (files.some(([file]) => fs.lstatSync(file, { throwIfNoEntry: false }))) throw new DiagnosticError('release-publication-output-already-exists');
  diagnostic.confirmed();
  diagnostic.at('request-and-notes-write', { output: 'release-publication-request-and-release-notes-handoff' });
  diagnostic.writeState = 'request-and-notes-may-be-partial';
  fs.mkdirSync(requestDir, { recursive: true });
  fs.mkdirSync(notesDir, { recursive: true });
  for (const [file, content] of files) fs.writeFileSync(file, content, { encoding: 'utf8', flag: 'wx' });
  return {};
};

const publicationDecision = (input: ControlInput): { releaseVersion: string; targetIdentity: string } => {
  const releaseVersion = scalar(input, 'releaseVersion');
  const targetIdentity = scalar(input, 'targetIdentity');
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(releaseVersion) || scalar(input, 'releaseIdentity') !== `v${releaseVersion}` || targetIdentity.length > 200) throw new DiagnosticError('release-publication-decision-invalid');
  return { releaseVersion, targetIdentity };
};

const verifyPublicationRequest = (input: ControlInput): ControlResult => {
  const request = JSON.parse(verifySidecar(input, 'release-publication-request', 'request.json', 'request.json.sha256').toString('utf8')) as Record<string, unknown>;
  const fields = ['workflowRunId', 'workflowHeadSha', 'releaseRequestRunId', 'releaseIdentity', 'releaseNotesBodySha256', 'approvalId', 'approvalExpiresAt'];
  if (request.schema !== 'ci.release-publication-request.v2' || fields.some((name) => typeof request[name] !== 'string' || !request[name])) throw new DiagnosticError('request schema is invalid', { diagnosticCode: 'request-schema-is-invalid' });
  if (request.workflowRunId !== scalar(input, 'requestWorkflowRunId')) throw new DiagnosticError('request run ID is not bound to workflow_run', { diagnosticCode: 'request-run-id-is-not-bound-to-workflow-run' });
  if (request.workflowHeadSha !== scalar(input, 'requestHeadSha')) throw new DiagnosticError('request head SHA is not bound to workflow_run', { diagnosticCode: 'request-head-sha-is-not-bound-to-workflow-run' });
  if (!/^[1-9][0-9]*$/.test(String(request.releaseRequestRunId))) throw new DiagnosticError('release request run ID is invalid', { diagnosticCode: 'release-request-run-id-is-invalid' });
  if (!/^[a-f0-9]{64}$/.test(String(request.releaseNotesBodySha256))) throw new DiagnosticError('release notes body digest is invalid', { diagnosticCode: 'release-notes-body-digest-is-invalid' });
  publicationDecision(request as ControlInput);
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
  if (publicationRequest.schema !== 'ci.release-publication-request.v2') throw new DiagnosticError('publication request schema is invalid', { diagnosticCode: 'publication-request-schema-is-invalid' });
  if (publicationRequest.workflowRunId !== publicationRunId || publicationRequest.workflowRunId !== String(publicationRun.id)) throw new DiagnosticError('publication request run ID mismatch', { diagnosticCode: 'publication-request-run-id-mismatch' });
  if (publicationRequest.workflowHeadSha !== publicationRun.head_sha) throw new DiagnosticError('publication request head SHA mismatch', { diagnosticCode: 'publication-request-head-sha-mismatch' });
  if (publicationRequest.releaseRequestRunId !== releaseRunId || releaseRequest.request_run_id !== releaseRunId) throw new DiagnosticError('release request run ID mismatch', { diagnosticCode: 'release-request-run-id-mismatch' });
  if (releaseRequest.schema !== 'ci.release-request.v1' || !/^[a-f0-9]{40}$/.test(releaseRequest.source_sha)) throw new DiagnosticError('release request schema is invalid', { diagnosticCode: 'release-request-schema-is-invalid' });
  if (releaseRequest.event !== 'tag') throw new DiagnosticError('release request event is invalid', { diagnosticCode: 'release-request-event-is-invalid' });
  const expectedName = scalar(input, 'releaseRequestTagWorkflowName');
  const expectedPath = scalar(input, 'releaseRequestTagWorkflowPath');
  const releaseRunPath = typeof releaseRun.path === 'string' ? releaseRun.path.split('@', 1)[0] : '';
  if (releaseRun.name !== expectedName || releaseRunPath !== expectedPath || releaseRun.event !== 'push') throw new DiagnosticError('release request workflow provenance is invalid', { diagnosticCode: 'release-request-workflow-provenance-is-invalid' });
  if (releaseRequest.ref !== `refs/tags/${releaseRequest.tag}` || releaseRun.head_sha !== releaseRequest.source_sha) throw new DiagnosticError('tag request source provenance is invalid', { diagnosticCode: 'tag-request-source-provenance-is-invalid' });
  publicationDecision(publicationRequest as ControlInput);
  const body = notes.body;
  if (notes.schema !== 'ci.release-notes.v1' || notes.source_contract !== 'git.release-flow' || notes.source_field !== 'body' || typeof body !== 'string' || !body) throw new DiagnosticError('release notes schema is invalid', { diagnosticCode: 'release-notes-schema-is-invalid' });
  const bodySha256 = sha256(body);
  if (bodySha256 !== notes.body_sha256 || bodySha256 !== approval.body_sha256 || bodySha256 !== publicationRequest.releaseNotesBodySha256 || bodySha256 !== approvedBodySha256) throw new DiagnosticError('release notes body digest mismatch', { diagnosticCode: 'release-notes-body-digest-mismatch' });
  if (approval.schema !== 'ci.release-notes-approval.v1' || approval.source_contract !== 'git.release-flow' || approval.source_field !== 'body') throw new DiagnosticError('release notes approval schema is invalid', { diagnosticCode: 'release-notes-approval-schema-is-invalid' });
  if (notes.release_identity !== publicationRequest.releaseIdentity || approval.release_identity !== publicationRequest.releaseIdentity || releaseRequest.tag !== publicationRequest.releaseIdentity) throw new DiagnosticError('release identity mismatch', { diagnosticCode: 'release-identity-mismatch' });
  if (approval.approval_id !== publicationRequest.approvalId || approval.approval_id !== approvalId) throw new DiagnosticError('approval ID mismatch', { diagnosticCode: 'approval-id-mismatch' });
  parseFutureRfc3339(publicationRequest.approvalExpiresAt);
  return {};
};

const verifyApproval = (input: ControlInput): ControlResult => {
  const request = readJson(rootPath(input, 'authority/publication-request.json'));
  if (request.schema !== 'ci.release-publication-request.v2') throw new DiagnosticError('publication request schema is invalid', { diagnosticCode: 'publication-request-schema-is-invalid' });
  publicationDecision(request as ControlInput);
  parseFutureRfc3339(request.approvalExpiresAt);
  if (request.approvalId !== scalar(input, 'approvalId')) throw new DiagnosticError('approval ID changed before publication', { diagnosticCode: 'approval-id-changed-before-publication' });
  if (request.releaseNotesBodySha256 !== scalar(input, 'approvalBodySha256')) throw new DiagnosticError('approved body digest changed before publication', { diagnosticCode: 'approved-body-digest-changed-before-publication' });
  return {};
};

export const runControl = (input: ControlInput): ControlResult => {
  const diagnostic = new FailureContext('ci-release-publication-control', 'publication-control');
  try {
  diagnostic.at('control-input-validation', { input: 'publication-request-and-approval' });
  const details: Record<string, unknown> = {};
  for (const name of ['requestHeadSha', 'approvalBodySha256']) if (/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(input[name] ?? '')) details[name] = input[name];
  for (const name of ['releaseRequestRunId', 'requestWorkflowRunId']) if (/^[1-9][0-9]*$/.test(input[name] ?? '')) details[name] = input[name];
  if (['create-request', 'verify-publication-request', 'verify-provenance', 'verify-approval'].includes(input.operation)) diagnostic.at(input.operation, details);
  if (input.operation === 'create-request') return createRequest(input, diagnostic);
  if (input.operation === 'verify-publication-request') return verifyPublicationRequest(input);
  if (input.operation === 'verify-provenance') return verifyProvenance(input);
  if (input.operation === 'verify-approval') return verifyApproval(input);
  throw new DiagnosticError('release-publication-operation-invalid');
  } catch (error) { throw diagnostic.capture(error); }
};
