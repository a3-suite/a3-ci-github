import { describe, test, expect } from 'vitest';
import { renderQualitySummary } from '../src/summary.js';

const row = (result: string, reason?: string) => ({
  unit: 'unit',
  execution: 'test command',
  result,
  evidence: 'evidence.log',
  collection: result === 'success' ? '完了' : '一部取得',
  ...(reason ? { reason } : {}),
});

describe('renderQualitySummary(QualitySummaryInput)', () => {
  // target_id: renderQualitySummary(QualitySummaryInput)
  test('renders success and a stable digest', () => {
    // Arrange
    const input = { jobs: [row('success')] };
    // Act
    const first = renderQualitySummary(input);
    const second = renderQualitySummary(input);
    // Assert
    expect(first.status).toBe('success');
    expect(first.markdown).toMatch(/ジョブサマリ/);
    expect(first.digest).toBe(second.digest);
    expect(first.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  // target_id: renderQualitySummary(QualitySummaryInput)
  test('preserves failure states with deterministic precedence', () => {
    // Arrange
    const inputs = [{ jobs: [{ ...row('blocked', 'blocked'), collection: '完了' }] }, { jobs: [row('判定不能', 'unknown')] }, { jobs: [row('failed', 'failed'), row('blocked', 'blocked')] }, { jobs: [{ ...row('未実施', 'not run'), collection: '完了' }] }, { jobs: [{ ...row('success'), collection: '取得不可' }] }];
    // Act
    const statuses = inputs.map((input) => renderQualitySummary(input).status);
    // Assert
    expect(statuses).toStrictEqual(['blocked', 'unresolved', 'failed', 'blocked', 'unresolved']);
  });

  // target_id: renderQualitySummary(QualitySummaryInput)
  test('excludes intentionally-not-applicable rows from aggregation', () => {
    // Arrange
    const inputs = [
      { jobs: [{ ...row('success'), collection: '完了' }, row('対象外', 'excluded by trust branch')] },
      { jobs: [{ ...row('success'), collection: '完了' }, { ...row('対象外', 'disabled by owner contract'), collection: '取得不可' }] },
    ];
    // Act
    const rendered = inputs.map((input) => renderQualitySummary(input));
    // Assert
    expect(rendered.map((item) => item.status)).toStrictEqual(['success', 'success']);
    expect(rendered[0].markdown).toMatch(/⏭ 対象外/);
  });

  // target_id: renderQualitySummary(QualitySummaryInput)
  test('normalizes raw GitHub job results while preserving caller applicability', () => {
    const input = {
      jobs: [
        { unit: 'build', execution: 'build', rawResult: 'failure', applicable: true, evidence: 'run' },
        { unit: 'optional', execution: 'optional', rawResult: 'skipped', applicable: false, evidence: 'run', reason: 'disabled by owner policy' },
      ],
    };
    const rendered = renderQualitySummary(input);
    expect(rendered.status).toBe('failed');
    expect(rendered.markdown).toMatch(/❌ 失敗/);
    expect(rendered.markdown).toMatch(/⏭ 対象外/);
    expect(rendered.markdown).toMatch(/job result: failure/);
    expect(rendered.markdown).toMatch(/disabled by owner policy/);
    const cases = [
      ['success', 'success', '✅ 成功'],
      ['failure', 'failed', '❌ 失敗'],
      ['cancelled', 'unresolved', '⏭ 未実施'],
      ['skipped', 'unresolved', '⏭ 未実施'],
      ['unknown', 'unresolved', '⚠️ 判定不能'],
    ] as const;
    for (const [rawResult, status, label] of cases) {
      // Arrange
      const raw = { jobs: [{ unit: 'build', execution: 'build', rawResult, applicable: true, evidence: 'run' }] };
      // Act
      const result = renderQualitySummary(raw);
      // Assert
      expect(result.status, rawResult).toBe(status);
      expect(result.markdown, rawResult).toContain(label);
      if (rawResult !== 'success') expect(result.markdown, rawResult).toContain(`job result: ${rawResult}`);
    }
  });

  // target_id: renderQualitySummary(QualitySummaryInput)
  test('rejects ambiguous raw results and unexplained exclusions', () => {
    const common = { unit: 'unit', execution: 'command', evidence: 'run' };
    expect(() => renderQualitySummary({ jobs: [{
      ...common, rawResult: 'success', applicable: true, result: 'success', collection: '完了',
    }] })).toThrow(/ci-summary-result-source-ambiguous/);
    expect(() => renderQualitySummary({ jobs: [{
      ...common, rawResult: 'skipped', applicable: false,
    }] })).toThrow(/ci-summary-reason-required/);
  });

  // target_id: renderQualitySummary(QualitySummaryInput)
  test('rejects an input where every row is excluded', () => {
    // Arrange
    const input = { jobs: [row('対象外', 'excluded')] };
    // Act + Assert
    expect(() => renderQualitySummary(input)).toThrow(/ci-summary-all-excluded/);
  });

  // target_id: renderQualitySummary(QualitySummaryInput)
  test('keeps failure precedence in the presence of excluded rows', () => {
    // Arrange
    const input = { jobs: [row('failed', 'hard failure'), row('対象外', 'excluded')] };
    // Act + Assert
    expect(renderQualitySummary(input).status).toBe('failed');
  });

  // target_id: renderQualitySummary(QualitySummaryInput)
  test('rejects missing rows and reasons', () => {
    // Arrange
    const inputs = [{}, { jobs: [row('failed')] }];
    // Act
    const failures = inputs.map((input) => { try { renderQualitySummary(input); } catch (error) { return error; } return undefined; });
    // Assert
    expect(String(failures[0])).toMatch(/ci-summary-rows-invalid/);
    expect(String(failures[1])).toMatch(/ci-summary-reason-required/);
  });
});
