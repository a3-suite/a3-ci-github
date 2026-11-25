import { describe, expect, test, vi } from 'vitest';
import { DiagnosticError, FailureContext } from '../failure.mts';

describe('failure evidence', () => {
  // contract_id: contract.ci-failure-diagnostics.actionable
  // integration_id: failure-evidence
  // test_level: integration
  test('known validation retains comparison, stage and existing state', () => {
    const context = new FailureContext('ci-release-assembly', 'assemble');
    context.at('checksum-validation', { asset: 'tool.zip' });
    context.confirmed('inventory-validation');
    const evidence = context.evidence(new DiagnosticError('checksum-mismatch', { diagnostics: { field: 'sha256', expected: 'a'.repeat(64), observed: 'b'.repeat(64) } }));
    expect(evidence.classification.reason).toBe('checksum-mismatch');
    const legacy = new DiagnosticError('Internal owner prose remains unchanged', { diagnosticCode: 'approval-expired' });
    expect(context.evidence(legacy).classification).toMatchObject({ reason: 'approval-expired', cause: 'known' });
    expect(legacy.message).toBe('Internal owner prose remains unchanged');
    expect(context.evidence(new Error('approval-expired')).classification.cause).toBe('unknown');
    expect(evidence.comparison).toEqual({ field: 'sha256', expected: 'a'.repeat(64), observed: 'b'.repeat(64) });
    expect(evidence['execution-state']).toMatchObject({ outcome: 'failure', lastConfirmed: 'inventory-validation', write: 'not-started' });
    expect(evidence['evidence-location'].artifact).toBe('not-generated');
  });
  // contract_id: contract.ci-failure-diagnostics.actionable
  // integration_id: failure-evidence
  // test_level: integration
  test('source reports the declared checked-out revision and never a pull request event SHA', () => {
    const head = 'a'.repeat(40);
    const merge = 'b'.repeat(40);
    const source = (environment) => {
      for (const [name, value] of Object.entries(environment)) vi.stubEnv(name, value);
      try { return new FailureContext('ci-quality-adapter', 'quality-adapter').evidence(new DiagnosticError('quality-adapter-failed')).context.source; }
      finally { vi.unstubAllEnvs(); }
    };
    expect(source({ CI_SOURCE_REVISION: head, GITHUB_EVENT_NAME: 'pull_request', GITHUB_SHA: merge })).toBe(head);
    expect(source({ CI_SOURCE_REVISION: '', GITHUB_EVENT_NAME: 'pull_request', GITHUB_SHA: merge })).toBe('unavailable');
    expect(source({ CI_SOURCE_REVISION: '', GITHUB_EVENT_NAME: 'pull_request_target', GITHUB_SHA: merge })).toBe('unavailable');
    expect(source({ CI_SOURCE_REVISION: 'refs/heads/main', GITHUB_EVENT_NAME: 'push', GITHUB_SHA: merge })).toBe('unavailable');
    expect(source({ CI_SOURCE_REVISION: '', GITHUB_EVENT_NAME: 'push', GITHUB_SHA: merge })).toBe(merge);
  });
});
