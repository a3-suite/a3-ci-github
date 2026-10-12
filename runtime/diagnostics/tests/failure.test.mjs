import { describe, expect, test, vi } from 'vitest';
import { DiagnosticError, FailureContext } from '../failure.mts';

describe('failure evidence', () => {
  // contract_id: contract.ci-failure-diagnostics.actionable
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
  test('unknown exceptions retain context without protected messages or stack', () => {
    const context = new FailureContext('ci-config-snapshot', 'snapshot');
    context.at('input-validation', { input: 'sources-json' });
    const evidence = context.evidence(new Error('secret-token and private response'));
    expect(evidence.classification).toMatchObject({ reason: 'unknown-failure', cause: 'unknown', stage: 'input-validation' });
    expect(evidence.context.inputs).toEqual({ input: 'sources-json' });
    expect(JSON.stringify(evidence)).not.toContain('secret-token');
    expect(evidence['next-check'].unknownCause).toBe(true);
  });
  // contract_id: contract.ci-failure-diagnostics.actionable
  test('diagnostic sink failure does not mask primary failure or retry', () => {
    const sink = vi.spyOn(process.stderr, 'write').mockImplementation(() => { throw new Error('sink failed'); });
    try {
      expect(new FailureContext('ci-release-publisher', 'publish').report(new DiagnosticError('provider-write-failed'))).toBe('provider-write-failed');
      expect(sink).toHaveBeenCalledTimes(1);
    } finally { sink.mockRestore(); }
  });
});
