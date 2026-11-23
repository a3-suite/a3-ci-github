import fs from 'node:fs';
import path from 'node:path';
import { describe, test, expect, onTestFinished } from 'vitest';
import { verifyRequestTrigger } from '../request-trigger.js';
import { rejectedRequestTriggerEnvironments, requestTriggerEnvironment } from './request-trigger-fixture.js';

describe('verifyRequestTrigger(requestWorkflow, env)', () => {
  // evidence_role: contract
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

  // evidence_role: contract
  // test_level: integration
  // integration_id: request-trigger-event-file
  test('rejects each trigger field that does not match the request workflow dispatch', () => {
    // Arrange
    // Real files cover event decoding and missing/unreadable event boundaries.
    const temporaryRoot = path.resolve('tests/tmp');
    fs.mkdirSync(temporaryRoot, { recursive: true });
    const root = fs.mkdtempSync(path.join(temporaryRoot, 'request-trigger-'));
    onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const { field, reason, env } of rejectedRequestTriggerEnvironments(root, 'release-publication-request')) {
      let failure: unknown;
      try {
        verifyRequestTrigger('release-publication-request', env);
      } catch (error) {
        failure = error;
      }
      const details = (failure as { details?: { field?: string } })?.details;
      expect(String(failure), field).toBe(`DiagnosticError: ${reason}`);
      if (reason === 'request-trigger-mismatch') expect(details?.field, field).toBe(field);
      else expect(JSON.stringify(details ?? {})).not.toContain('secret-value');
    }
  });
});
