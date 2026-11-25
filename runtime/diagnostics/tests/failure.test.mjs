import { describe, expect, test, vi } from 'vitest';
import { DiagnosticError, FailureContext } from '../failure.mts';

describe('failure evidence', () => {
  // target_id: FailureContext.evidence(error)
  test('unknown exceptions retain context without protected messages or stack', () => {
    const context = new FailureContext('ci-config-snapshot', 'snapshot');
    context.at('input-validation', { input: 'sources-json' });
    const evidence = context.evidence(new Error('secret-token and private response'));
    expect(evidence.classification).toMatchObject({ reason: 'unknown-failure', cause: 'unknown', stage: 'input-validation' });
    expect(evidence.context.inputs).toEqual({ input: 'sources-json' });
    expect(JSON.stringify(evidence)).not.toContain('secret-token');
    expect(evidence['next-check'].unknownCause).toBe(true);
  });
  // target_id: FailureContext.report(error)
  test('diagnostic sink failure does not mask primary failure or retry', () => {
    const sink = vi.spyOn(process.stderr, 'write').mockImplementation(() => { throw new Error('sink failed'); });
    try {
      expect(new FailureContext('ci-release-publisher', 'publish').report(new DiagnosticError('provider-write-failed'))).toBe('provider-write-failed');
      expect(sink).toHaveBeenCalledTimes(1);
    } finally { sink.mockRestore(); }
  });
});
