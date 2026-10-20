import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { aggregateCoverageMaps, loadDefinition } from './coverage-tools/contract-subject-coverage.mjs';

describe("repository-contract-subject-execution", () => {

  // flow_id: repository-contract-subject-execution
  test('measurement and aggregation reject declared bundles labelled as source', () => {
    // Arrange
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    mkdirSync(path.join(root, 'tmp'), { recursive: true });
    const directory = mkdtempSync(path.join(root, 'tmp/source-only-rejection-'));
    try {
      for (const sourceFile of ['actions/ci-change-scope/dist/index.js', 'runtime/rust-release/dist/index.mjs']) {
        const output = path.join(directory, sourceFile, 'lcov.info');
        const config = { root, cwd: root, tests: [], include: [sourceFile], exclude: [], typescript: false, lcovPath: output };
        const map = { groupId: 'mislabelled-source', scope: 'source', cwd: root,
          files: [{ sourceFile, branches: { hit: 1, total: 1 }, lines: { hit: 1, total: 1 } }] };
        // Act
        const result = spawnSync(process.execPath, ['tests/coverage-tools/measure-coverage.mjs', JSON.stringify(config)], { cwd: root, encoding: 'utf8' });
        let aggregateFailure;
        try { aggregateCoverageMaps([map], root); } catch (error) { aggregateFailure = error; }
        // Assert
        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/source-only.*generated distribution/);
        expect(existsSync(path.dirname(output))).toBe(false);
        expect(String(aggregateFailure)).toMatch(/source-only.*generated distribution/);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});



describe("repository-contract-subject-execution", () => {

  // flow_id: repository-contract-subject-execution
  test('definition check retains the rejected mapping as failure details without private parser text', () => {
    // Arrange
    mkdirSync(path.resolve('tests/tmp'), { recursive: true });
    const directory = mkdtempSync(path.resolve('tests/tmp/execution-definition-diagnostic-'));
    try {
      const invalid = structuredClone(loadDefinition());
      const subject = invalid.subjects[0];
      const segment = subject.segments.find((candidate) => candidate.status !== 'excluded');
      segment.tests = ['../../../../outside.test.mjs'];
      const invalidPath = path.join(directory, 'escaping.json');
      writeFileSync(invalidPath, JSON.stringify(invalid));
      const malformedPath = path.join(directory, 'private-marker.json');
      writeFileSync(malformedPath, '{');
      const check = (definitionPath) => {
        const result = spawnSync(process.execPath, ['tests/coverage-tools/contract-subject-coverage.mjs', '--check', '--definition', definitionPath], { encoding: 'utf8' });
        const line = result.stderr.split('\n').find((value) => value.startsWith('ci-failure-diagnostic:'));
        return { result, evidence: JSON.parse(line?.slice('ci-failure-diagnostic:'.length) ?? '{}') };
      };
      // Act
      const escaping = check(invalidPath);
      const malformed = check(malformedPath);
      // Assert
      expect(escaping.result.status).toBe(1);
      expect(escaping.evidence.classification).toMatchObject({ subject: 'repository-managed-source-integrity', operation: 'contract-execution-mapping', stage: 'execution-definition-validation', reason: 'execution-definition-invalid' });
      expect(escaping.evidence.comparison).toStrictEqual({ field: 'contract-subject-execution', expected: 'explicit-segments-with-tests-inside-repository', observed: `${subject.subjectId}/${segment.id}: test path must resolve inside project root` });
      expect(escaping.evidence['execution-state'].write).toBe('not-started');
      expect(malformed.result.status).toBe(1);
      expect(malformed.evidence.comparison.observed).toBe('unknown-failure');
      expect(JSON.stringify(malformed.evidence)).not.toContain('private-marker');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
