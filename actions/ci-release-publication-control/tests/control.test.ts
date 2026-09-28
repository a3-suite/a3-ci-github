import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runControl } from '../src/control.js';

const writeJsonWithSidecar = (directory: string, filename: string, value: unknown): void => {
  fs.mkdirSync(directory, { recursive: true });
  const content = `${JSON.stringify(value)}\n`;
  fs.writeFileSync(path.join(directory, filename), content);
  fs.writeFileSync(path.join(directory, `${filename}.sha256`), `${crypto.createHash('sha256').update(content).digest('hex')}  ${filename}\n`);
};

// integration_id: ci-release-publication-control-source
test('creates and verifies a publication request', () => {
  // Arrange
  const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-publication-'));
  const releaseNotes = '# Release\n';
  const common = { rootDirectory, operation: 'create-request', releaseRequestRunId: '11', requestWorkflowRunId: '22', requestHeadSha: 'a'.repeat(40), releaseIdentity: 'v1.2.3', releaseNotes, approvalId: 'approval-1', approvalExpiresAt: '2999-01-01T00:00:00Z', approvalBodySha256: crypto.createHash('sha256').update(releaseNotes).digest('hex') };
  runControl(common);

  // Act
  const result = runControl({ ...common, operation: 'verify-publication-request' });

  // Assert
  assert.equal(result.requestRunId, '11');
  fs.rmSync(rootDirectory, { recursive: true, force: true });
});

// integration_id: ci-release-publication-control-source
test('rejects a changed approval ID after tag provenance verification', () => {
  // Arrange
  const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-publication-provenance-'));
  const releaseNotes = '# Release\n';
  const bodyDigest = crypto.createHash('sha256').update(releaseNotes).digest('hex');
  const common = { rootDirectory, operation: 'create-request', releaseRequestRunId: '11', requestWorkflowRunId: '22', requestHeadSha: 'a'.repeat(40), releaseIdentity: 'v1.2.3', releaseNotes, approvalId: 'approval-1', approvalExpiresAt: '2999-01-01T00:00:00Z', approvalBodySha256: bodyDigest };
  runControl(common);
  writeJsonWithSidecar(path.join(rootDirectory, 'release-request'), 'release-request.json', { schema: 'ci.release-request.v1', event: 'tag', ref: 'refs/tags/v1.2.3', source_sha: 'b'.repeat(40), request_run_id: '11', tag: 'v1.2.3' });
  fs.mkdirSync(path.join(rootDirectory, 'run-metadata'));
  fs.writeFileSync(path.join(rootDirectory, 'run-metadata/publication-request.json'), JSON.stringify({ id: 22, head_sha: 'a'.repeat(40) }));
  fs.writeFileSync(path.join(rootDirectory, 'run-metadata/release-request.json'), JSON.stringify({ id: 11, head_sha: 'b'.repeat(40), name: 'release-request-tag', path: '.github/workflows/release-request-tag.yml@refs/heads/main', event: 'push' }));
  runControl({ ...common, operation: 'verify-provenance', publicationRequestRunId: '22', releaseRequestTagWorkflowName: 'release-request-tag', releaseRequestTagWorkflowPath: '.github/workflows/release-request-tag.yml' });
  fs.mkdirSync(path.join(rootDirectory, 'authority'));
  fs.writeFileSync(path.join(rootDirectory, 'authority/publication-request.json'), JSON.stringify({ approvalId: 'approval-1', approvalExpiresAt: '2999-01-01T00:00:00Z', releaseNotesBodySha256: bodyDigest }));
  runControl({ ...common, operation: 'verify-approval' });
  let failure: unknown;

  // Act
  try {
    runControl({ ...common, operation: 'verify-approval', approvalId: 'changed' });
  } catch (error) {
    failure = error;
  }

  // Assert
  assert.match(String(failure), /approval ID changed/);
  fs.rmSync(rootDirectory, { recursive: true, force: true });
});

// integration_id: ci-release-publication-control-source
test('rejects invalid publication request inputs', () => {
  // Arrange
  const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-publication-invalid-'));
  const releaseNotes = '# Release\n';
  const valid = { rootDirectory, operation: 'create-request', releaseRequestRunId: '11', requestWorkflowRunId: '22', requestHeadSha: 'a'.repeat(40), releaseIdentity: 'v1.2.3', releaseNotes, approvalId: 'approval-1', approvalExpiresAt: '2999-01-01T00:00:00Z', approvalBodySha256: crypto.createHash('sha256').update(releaseNotes).digest('hex') };
  const cases: [Record<string, string>, RegExp][] = [
    [{ ...valid, operation: 'unknown' }, /operation-invalid/],
    [{ ...valid, releaseRequestRunId: '0' }, /positive integers/],
    [{ ...valid, requestWorkflowRunId: 'x' }, /positive integers/],
    [{ ...valid, requestHeadSha: 'a' }, /head SHA is invalid/],
    [{ ...valid, releaseNotes: '' }, /release notes are missing/],
    [{ ...valid, approvalBodySha256: 'a' }, /approved body SHA-256 is invalid/],
    [{ ...valid, approvalBodySha256: 'a'.repeat(64) }, /approved body digest/],
  ];
  const failures: unknown[] = [];

  // Act
  for (const [input] of cases) {
    try { runControl(input as typeof valid); } catch (error) { failures.push(error); }
  }

  // Assert
  assert.equal(failures.length, cases.length);
  failures.forEach((failure, index) => assert.match(String(failure), cases[index][1]));
  fs.rmSync(rootDirectory, { recursive: true, force: true });
});
