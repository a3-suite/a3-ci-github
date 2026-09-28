import { strict as assert } from 'node:assert';
import test from 'node:test';
import { renderQualitySummary } from '../src/summary.js';

const row = (result: string, reason?: string) => ({
  unit: 'unit',
  execution: 'test command',
  result,
  evidence: 'evidence.log',
  collection: result === 'success' ? '完了' : '一部取得',
  ...(reason ? { reason } : {}),
});

// target_id: renderQualitySummary(QualitySummaryInput)
test('renders success and a stable digest', () => {
  // Arrange
  const input = { jobs: [row('success')] };
  // Act
  const first = renderQualitySummary(input);
  const second = renderQualitySummary(input);
  // Assert
  assert.equal(first.status, 'success');
  assert.match(first.markdown, /ジョブサマリ/);
  assert.equal(first.digest, second.digest);
  assert.match(first.digest, /^sha256:[0-9a-f]{64}$/);
});

// target_id: renderQualitySummary(QualitySummaryInput)
test('preserves failure states with deterministic precedence', () => {
  // Arrange
  const inputs = [{ jobs: [{ ...row('blocked', 'blocked'), collection: '完了' }] }, { jobs: [row('判定不能', 'unknown')] }, { jobs: [row('failed', 'failed'), row('blocked', 'blocked')] }, { jobs: [{ ...row('未実施', 'not run'), collection: '完了' }] }, { jobs: [{ ...row('success'), collection: '取得不可' }] }];
  // Act
  const statuses = inputs.map((input) => renderQualitySummary(input).status);
  // Assert
  assert.deepEqual(statuses, ['blocked', 'unresolved', 'failed', 'blocked', 'unresolved']);
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
  assert.deepEqual(rendered.map((item) => item.status), ['success', 'success']);
  assert.match(rendered[0].markdown, /⏭ 対象外/);
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
  assert.equal(rendered.status, 'failed');
  assert.match(rendered.markdown, /❌ 失敗/);
  assert.match(rendered.markdown, /⏭ 対象外/);
  assert.match(rendered.markdown, /job result: failure/);
  assert.match(rendered.markdown, /disabled by owner policy/);
});

// target_id: renderQualitySummary(QualitySummaryInput)
test('rejects ambiguous raw results and unexplained exclusions', () => {
  const common = { unit: 'unit', execution: 'command', evidence: 'run' };
  assert.throws(() => renderQualitySummary({ jobs: [{
    ...common, rawResult: 'success', applicable: true, result: 'success', collection: '完了',
  }] }), /ci-summary-result-source-ambiguous/);
  assert.throws(() => renderQualitySummary({ jobs: [{
    ...common, rawResult: 'skipped', applicable: false,
  }] }), /ci-summary-reason-required/);
});

// target_id: renderQualitySummary(QualitySummaryInput)
test('rejects an input where every row is excluded', () => {
  // Arrange
  const input = { jobs: [row('対象外', 'excluded')] };
  // Act + Assert
  assert.throws(() => renderQualitySummary(input), /ci-summary-all-excluded/);
});

// target_id: renderQualitySummary(QualitySummaryInput)
test('keeps failure precedence in the presence of excluded rows', () => {
  // Arrange
  const input = { jobs: [row('failed', 'hard failure'), row('対象外', 'excluded')] };
  // Act + Assert
  assert.equal(renderQualitySummary(input).status, 'failed');
});

// target_id: renderQualitySummary(QualitySummaryInput)
test('rejects missing rows and reasons', () => {
  // Arrange
  const inputs = [{}, { jobs: [row('failed')] }];
  // Act
  const failures = inputs.map((input) => { try { renderQualitySummary(input); } catch (error) { return error; } return undefined; });
  // Assert
  assert.match(String(failures[0]), /ci-summary-rows-invalid/);
  assert.match(String(failures[1]), /ci-summary-reason-required/);
});
