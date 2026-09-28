import crypto from 'node:crypto';

type ReleaseNotesHandoff = { schema: 'ci.release-notes.v1'; source_contract: 'git.release-flow'; source_field: 'body'; release_identity: string; body: string; body_sha256: string };
type ReleaseNotesApproval = { schema: 'ci.release-notes-approval.v1'; source_contract: 'git.release-flow'; source_field: 'body'; release_identity: string; body_sha256: string; approval_id: string };
export type ReleaseNotesBinding = { releaseIdentity: string; bodyDigest: string; approvalId: string };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const requireText = (value: unknown, error: string, allowNewline = false): string => {
  if (typeof value !== 'string' || value.length === 0 || /[\0]/.test(value) || (!allowNewline && /[\r\n]/.test(value))) throw new Error(error);
  return value;
};
const parseHandoff = (input: unknown): ReleaseNotesHandoff => {
  if (!isRecord(input) || input.schema !== 'ci.release-notes.v1') throw new Error('release-notes-schema-invalid');
  if (input.source_contract !== 'git.release-flow' || input.source_field !== 'body') throw new Error('release-notes-source-invalid');
  const digest = requireText(input.body_sha256, 'release-notes-digest-missing');
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('release-notes-digest-invalid');
  return { schema: 'ci.release-notes.v1', source_contract: 'git.release-flow', source_field: 'body', release_identity: requireText(input.release_identity, 'release-notes-identity-invalid'), body: requireText(input.body, 'release-notes-body-missing', true), body_sha256: digest };
};
const parseApproval = (input: unknown): ReleaseNotesApproval => {
  if (!isRecord(input) || input.schema !== 'ci.release-notes-approval.v1') throw new Error('release-notes-approval-schema-invalid');
  if (input.source_contract !== 'git.release-flow' || input.source_field !== 'body') throw new Error('release-notes-approval-source-invalid');
  const digest = requireText(input.body_sha256, 'release-notes-approval-digest-missing');
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('release-notes-approval-digest-invalid');
  return { schema: 'ci.release-notes-approval.v1', source_contract: 'git.release-flow', source_field: 'body', release_identity: requireText(input.release_identity, 'release-notes-approval-identity-invalid'), body_sha256: digest, approval_id: requireText(input.approval_id, 'release-notes-approval-missing') };
};

export const validateReleaseNotesBinding = (handoffInput: unknown, approvalInput: unknown, expectedReleaseIdentity: string): ReleaseNotesBinding => {
  const handoff = parseHandoff(handoffInput);
  const approval = parseApproval(approvalInput);
  const expectedIdentity = requireText(expectedReleaseIdentity, 'release-notes-identity-invalid');
  if (handoff.release_identity !== expectedIdentity || approval.release_identity !== expectedIdentity) throw new Error('release-notes-identity-mismatch');
  const bodyDigest = crypto.createHash('sha256').update(handoff.body, 'utf8').digest('hex');
  if (bodyDigest !== handoff.body_sha256) throw new Error('release-notes-digest-mismatch');
  if (approval.body_sha256 !== bodyDigest) throw new Error('release-notes-approval-mismatch');
  return { releaseIdentity: handoff.release_identity, bodyDigest, approvalId: approval.approval_id };
};
