import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import test from 'node:test';
import { validateReleaseNotesBinding } from '../src/binding.js';

// target_id: validateReleaseNotesBinding(ReleaseNotesHandoff,ReleaseNotesApproval,string)
test('binds approved release notes by identity and digest', () => {
  // Arrange
  const body = '# Release v1.2.3\n';
  const digest = crypto.createHash('sha256').update(body).digest('hex');
  const handoff = { schema: 'ci.release-notes.v1', source_contract: 'git.release-flow', source_field: 'body', release_identity: 'v1.2.3', body, body_sha256: digest };
  const approval = { schema: 'ci.release-notes-approval.v1', source_contract: 'git.release-flow', source_field: 'body', release_identity: 'v1.2.3', body_sha256: digest, approval_id: 'review-1' };
  // Act
  const result = validateReleaseNotesBinding(handoff, approval, 'v1.2.3');
  // Assert
  assert.deepEqual(result, { releaseIdentity: 'v1.2.3', bodyDigest: digest, approvalId: 'review-1' });
});

// target_id: validateReleaseNotesBinding(ReleaseNotesHandoff,ReleaseNotesApproval,string)
test('rejects a mismatched approval digest', () => {
  // Arrange
  const handoff = { schema: 'ci.release-notes.v1', source_contract: 'git.release-flow', source_field: 'body', release_identity: 'v1.2.3', body: 'body', body_sha256: crypto.createHash('sha256').update('body').digest('hex') };
  const approval = { schema: 'ci.release-notes-approval.v1', source_contract: 'git.release-flow', source_field: 'body', release_identity: 'v1.2.3', body_sha256: 'a'.repeat(64), approval_id: 'review-1' };
  let failure: unknown;
  // Act
  try { validateReleaseNotesBinding(handoff, approval, 'v1.2.3'); } catch (error) { failure = error; }
  // Assert
  assert.match(String(failure), /release-notes-approval-mismatch/);
});

// target_id: validateReleaseNotesBinding(ReleaseNotesHandoff,ReleaseNotesApproval,string)
test('rejects malformed release notes binding inputs', () => {
  // Arrange
  const body = 'body';
  const digest = crypto.createHash('sha256').update(body).digest('hex');
  const handoff = { schema: 'ci.release-notes.v1', source_contract: 'git.release-flow', source_field: 'body', release_identity: 'v1.2.3', body, body_sha256: digest };
  const approval = { schema: 'ci.release-notes-approval.v1', source_contract: 'git.release-flow', source_field: 'body', release_identity: 'v1.2.3', body_sha256: digest, approval_id: 'review-1' };
  const cases: [unknown, unknown, string, RegExp][] = [
    [{ ...handoff, schema: 'other' }, approval, 'v1.2.3', /schema-invalid/],
    [{ ...handoff, source_field: 'title' }, approval, 'v1.2.3', /source-invalid/],
    [{ ...handoff, body_sha256: '' }, approval, 'v1.2.3', /digest-missing/],
    [{ ...handoff, body_sha256: 'a' }, approval, 'v1.2.3', /digest-invalid/],
    [{ ...handoff, release_identity: 'v1\n' }, approval, 'v1.2.3', /identity-invalid/],
    [{ ...handoff, body: '' }, approval, 'v1.2.3', /body-missing/],
    [handoff, { ...approval, schema: 'other' }, 'v1.2.3', /approval-schema-invalid/],
    [handoff, { ...approval, source_contract: 'other' }, 'v1.2.3', /approval-source-invalid/],
    [handoff, { ...approval, body_sha256: 'a' }, 'v1.2.3', /approval-digest-invalid/],
    [handoff, { ...approval, approval_id: '' }, 'v1.2.3', /approval-missing/],
    [handoff, approval, 'v1.2.4', /identity-mismatch/],
    [{ ...handoff, body: 'changed' }, approval, 'v1.2.3', /digest-mismatch/],
  ];
  const failures: unknown[] = [];

  // Act
  for (const [handoffInput, approvalInput, identity] of cases) {
    try { validateReleaseNotesBinding(handoffInput, approvalInput, identity); } catch (error) { failures.push(error); }
  }

  // Assert
  assert.equal(failures.length, cases.length);
  failures.forEach((failure, index) => assert.match(String(failure), cases[index][3]));
});
