import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test, vi, expect } from 'vitest';
import { runControl } from '../../../runtime/release-publication/control.js';

const writeJsonWithSidecar = (directory: string, filename: string, value: unknown): void => {
  fs.mkdirSync(directory, { recursive: true });
  const content = `${JSON.stringify(value)}\n`;
  fs.writeFileSync(path.join(directory, filename), content);
  fs.writeFileSync(path.join(directory, `${filename}.sha256`), `${crypto.createHash('sha256').update(content).digest('hex')}  ${filename}\n`);
};

describe('ci-release-publication-control-source', () => {
  // integration_id: ci-release-publication-control-source
  // contract_id: contract.ci-release-publication-control.outputs
  test('creates and verifies a publication request', (t) => {
    // Arrange
    const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-publication-'));
    t.onTestFinished(() => fs.rmSync(rootDirectory, { recursive: true, force: true }));
    const releaseNotes = '# Release\n';
    const common = { rootDirectory, operation: 'create-request', releaseRequestRunId: '11', requestWorkflowRunId: '22', requestHeadSha: 'a'.repeat(40), releaseIdentity: 'v1.2.3', releaseVersion: '1.2.3', targetIdentity: 'owner/project', releaseNotes, approvalId: 'approval-1', approvalExpiresAt: '2999-01-01T00:00:00Z', approvalBodySha256: crypto.createHash('sha256').update(releaseNotes).digest('hex') };
    runControl(common);

    // Act
    const result = runControl({ ...common, operation: 'verify-publication-request' });

    // Assert
    expect(result.requestRunId).toBe('11');
    expect(JSON.parse(fs.readFileSync(path.join(rootDirectory, 'release-publication-request/request.json'), 'utf8'))).toMatchObject({ schema: 'ci.release-publication-request.v2', releaseVersion: '1.2.3', targetIdentity: 'owner/project' });

    // Arrange
    const files = ['release-publication-request/request.json', 'release-publication-request/request.json.sha256', 'release-notes-handoff/release-notes.json', 'release-notes-handoff/release-notes-approval.json'];
    const saved = files.map((file) => fs.readFileSync(path.join(rootDirectory, file), 'utf8'));
    // Act
    const replay = () => runControl({ ...common, approvalId: 'replacement-approval' });
    // Assert
    expect(replay).toThrow(/already-exists|EEXIST/);
    expect(files.map((file) => fs.readFileSync(path.join(rootDirectory, file), 'utf8'))).toStrictEqual(saved);

    for (const [index, filename] of files.entries()) {
      // Arrange
      const partial = path.join(rootDirectory, `partial-${index}`);
      fs.mkdirSync(path.dirname(path.join(partial, filename)), { recursive: true });
      fs.writeFileSync(path.join(partial, filename), 'existing evidence');
      // Act
      const create = () => runControl({ ...common, rootDirectory: partial });
      // Assert
      expect(create).toThrow(/already-exists|EEXIST/);
      expect(files.filter((file) => fs.existsSync(path.join(partial, file)))).toStrictEqual([filename]);
      expect(fs.readFileSync(path.join(partial, filename), 'utf8')).toBe('existing evidence');
    }

    // Arrange
    const collision = path.join(rootDirectory, 'collision');
    const approvalPath = path.join(collision, 'release-notes-handoff/release-notes-approval.json');
    const write = fs.writeFileSync;
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, bytes, options) => {
      if (String(file) === approvalPath) write(file, 'concurrent evidence');
      return write(file, bytes, options);
    });
    // Act
    const create = () => runControl({ ...common, rootDirectory: collision });
    // Assert
    try {
      expect(create).toThrow(/EEXIST/);
    } finally {
      spy.mockRestore();
    }
    expect(fs.readFileSync(approvalPath, 'utf8')).toBe('concurrent evidence');
  });

  // integration_id: ci-release-publication-control-source
  test('rejects a changed approval ID after tag provenance verification', () => {
    // Arrange
    const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-publication-provenance-'));
    const releaseNotes = '# Release\n';
    const bodyDigest = crypto.createHash('sha256').update(releaseNotes).digest('hex');
    const common = { rootDirectory, operation: 'create-request', releaseRequestRunId: '11', requestWorkflowRunId: '22', requestHeadSha: 'a'.repeat(40), releaseIdentity: 'v1.2.3', releaseVersion: '1.2.3', targetIdentity: 'owner/project', releaseNotes, approvalId: 'approval-1', approvalExpiresAt: '2999-01-01T00:00:00Z', approvalBodySha256: bodyDigest };
    runControl(common);
    writeJsonWithSidecar(path.join(rootDirectory, 'release-request'), 'release-request.json', { schema: 'ci.release-request.v1', event: 'tag', ref: 'refs/tags/v1.2.3', source_sha: 'b'.repeat(40), request_run_id: '11', tag: 'v1.2.3' });
    fs.mkdirSync(path.join(rootDirectory, 'run-metadata'));
    fs.writeFileSync(path.join(rootDirectory, 'run-metadata/publication-request.json'), JSON.stringify({ id: 22, head_sha: 'a'.repeat(40) }));
    fs.writeFileSync(path.join(rootDirectory, 'run-metadata/release-request.json'), JSON.stringify({ id: 11, head_sha: 'b'.repeat(40), name: 'release-request-tag', path: '.github/workflows/release-request-tag.yml@refs/heads/main', event: 'push' }));
    runControl({ ...common, operation: 'verify-provenance', publicationRequestRunId: '22', releaseRequestTagWorkflowName: 'release-request-tag', releaseRequestTagWorkflowPath: '.github/workflows/release-request-tag.yml' });
    fs.mkdirSync(path.join(rootDirectory, 'authority'));
    fs.writeFileSync(path.join(rootDirectory, 'authority/publication-request.json'), JSON.stringify({ schema: 'ci.release-publication-request.v2', releaseVersion: '1.2.3', targetIdentity: 'owner/project', releaseIdentity: 'v1.2.3', approvalId: 'approval-1', approvalExpiresAt: '2999-01-01T00:00:00Z', releaseNotesBodySha256: bodyDigest }));
    runControl({ ...common, operation: 'verify-approval' });
    let failure: unknown;

    // Act
    try {
      runControl({ ...common, operation: 'verify-approval', approvalId: 'changed' });
    } catch (error) {
      failure = error;
    }

    // Assert
    expect(String(failure)).toMatch(/approval ID changed/);
    fs.rmSync(rootDirectory, { recursive: true, force: true });
  });

  // integration_id: ci-release-publication-control-source
  test('rejects invalid publication request inputs', () => {
    // Arrange
    const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-publication-invalid-'));
    const releaseNotes = '# Release\n';
    const valid = { rootDirectory, operation: 'create-request', releaseRequestRunId: '11', requestWorkflowRunId: '22', requestHeadSha: 'a'.repeat(40), releaseIdentity: 'v1.2.3', releaseVersion: '1.2.3', targetIdentity: 'owner/project', releaseNotes, approvalId: 'approval-1', approvalExpiresAt: '2999-01-01T00:00:00Z', approvalBodySha256: crypto.createHash('sha256').update(releaseNotes).digest('hex') };
    const cases: [Record<string, string>, RegExp][] = [
      [{ ...valid, releaseVersion: '' }, /releaseVersion-invalid/],
      [{ ...valid, targetIdentity: '' }, /targetIdentity-invalid/],
      [{ ...valid, releaseVersion: '1.2.4' }, /decision-invalid/],
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
    expect(failures.length).toBe(cases.length);
    failures.forEach((failure, index) => expect(String(failure)).toMatch(cases[index][1]));
    fs.rmSync(rootDirectory, { recursive: true, force: true });
  });
  // integration_id: ci-release-publication-control-source
  // contract_id: contract.ci-release-publication-control.outputs
  test('rejects publication requests without a v2 owner decision', (t) => {
    // Arrange
    const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-publication-schema-'));
    t.onTestFinished(() => fs.rmSync(rootDirectory, { recursive: true, force: true }));
    const request = { schema: 'ci.release-publication-request.v2', workflowRunId: '22', workflowHeadSha: 'a'.repeat(40), releaseRequestRunId: '11', releaseIdentity: 'v1.2.3', releaseVersion: '1.2.3', targetIdentity: 'owner/project', releaseNotesBodySha256: 'b'.repeat(64), approvalId: 'approval-1', approvalExpiresAt: '2999-01-01T00:00:00Z' };
    const mutations = [{ schema: 'ci.release-publication-request.v1' }, { schema: 'unknown' }, { schema: undefined }, { releaseVersion: '' }, { targetIdentity: '' }, { releaseVersion: '1.2.4' }];
    for (const mutation of mutations) {
      writeJsonWithSidecar(path.join(rootDirectory, 'release-publication-request'), 'request.json', { ...request, ...mutation });
      fs.mkdirSync(path.join(rootDirectory, 'authority'), { recursive: true });
      fs.writeFileSync(path.join(rootDirectory, 'authority/publication-request.json'), JSON.stringify({ ...request, ...mutation }));
      // Act / Assert
      expect(() => runControl({ operation: 'verify-publication-request', rootDirectory, requestWorkflowRunId: '22', requestHeadSha: 'a'.repeat(40) })).toThrow();
      expect(() => runControl({ operation: 'verify-approval', rootDirectory, approvalId: 'approval-1', approvalBodySha256: 'b'.repeat(64) })).toThrow();
    }
  });

});
