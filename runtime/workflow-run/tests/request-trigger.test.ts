import fs from 'node:fs';
import path from 'node:path';
import { describe, test, expect, onTestFinished } from 'vitest';
import { verifyRequestTrigger } from '../request-trigger.js';
import { requestTriggerEnvironment } from './request-trigger-fixture.js';

describe('verifyRequestTrigger(requestWorkflow, env)', () => {
  // evidence_role: supplemental
  // test_level: integration
  // integration_id: request-trigger-event-file
  // Action entrypoint tests cover the public operation; this covers each rejected trigger field.
  test('accepts a successful default-branch dispatch of the request workflow', () => {
    // Arrange
    // Real files cover event decoding and missing/unreadable event boundaries.
    const temporaryRoot = path.resolve('tests/tmp');
    fs.mkdirSync(temporaryRoot, { recursive: true });
    const root = fs.mkdtempSync(path.join(temporaryRoot, 'request-trigger-'));
    onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
    // The fixture rewrites one event file, so each path form is verified right after it is written.
    const paths = ['.github/workflows/release-publication-request.yml@main', '.github/workflows/release-publication-request.yml'];
    // Act
    const results = paths.map((value) => verifyRequestTrigger('release-publication-request', requestTriggerEnvironment(root, 'release-publication-request', { path: value })));
    // Assert
    for (const result of results) expect(result).toEqual({ runId: '22', headSha: 'a'.repeat(40) });
  });

  // evidence_role: supplemental
  // test_level: integration
  // integration_id: request-trigger-event-file
  test('rejects each trigger field that does not match the request workflow dispatch', () => {
    // Arrange
    // Real files cover event decoding and missing/unreadable event boundaries.
    const temporaryRoot = path.resolve('tests/tmp');
    fs.mkdirSync(temporaryRoot, { recursive: true });
    const root = fs.mkdtempSync(path.join(temporaryRoot, 'request-trigger-'));
    onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
    const cases: [string, Record<string, unknown>, Record<string, string | undefined>][] = [
      ['event-name', {}, { GITHUB_EVENT_NAME: 'push' }],
      ['conclusion', { conclusion: 'failure' }, {}],
      ['repository', { repository: { full_name: 'other/project' } }, {}],
      ['workflow-name', { name: 'other-request' }, {}],
      ['event', { event: 'push' }, {}],
      ['head-branch', { head_branch: 'feature' }, {}],
      ['default-branch', {}, { GITHUB_EVENT_PATH: path.join(root, 'no-default-branch.json') }],
      ['workflow-path', { path: '.github/workflows/other.yml' }, {}],
      ['run-id', { id: 0 }, {}],
      ['head-sha', { head_sha: 'A'.repeat(40) }, {}],
    ];
    fs.writeFileSync(path.join(root, 'no-default-branch.json'), JSON.stringify({ repository: {}, workflow_run: JSON.parse(fs.readFileSync(requestTriggerEnvironment(root, 'release-publication-request').GITHUB_EVENT_PATH, 'utf8')).workflow_run }));
    fs.writeFileSync(path.join(root, 'invalid.json'), '{"secret-value"');
    // Act
    const failures = cases.map(([field, run, env]) => {
      try {
        verifyRequestTrigger('release-publication-request', { ...requestTriggerEnvironment(root, 'release-publication-request', run), ...env });
        return { field, details: undefined };
      } catch (error) {
        return { field, details: (error as { details?: { field?: string } }).details };
      }
    });
    // Assert
    for (const { field, details } of failures) expect(details?.field, field).toBe(field);
    for (const file of ['missing.json', 'invalid.json']) {
      let failure: unknown;
      try {
        verifyRequestTrigger('release-publication-request', { ...requestTriggerEnvironment(root, 'release-publication-request'), GITHUB_EVENT_PATH: path.join(root, file) });
      } catch (error) {
        failure = error;
      }
      expect(String(failure), file).toBe('DiagnosticError: request-trigger-event-unreadable');
      expect(JSON.stringify((failure as { details?: unknown }).details ?? {})).not.toContain('secret-value');
    }
  });
});
