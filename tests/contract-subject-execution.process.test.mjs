import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { aggregateCoverageMaps, collectSubjectCoverage, loadDefinition } from './coverage-tools/contract-subject-coverage.mjs';

describe("repository-contract-subject-execution", () => {

  test('definition check rejects coverage sources shared across instrumentation groups', (t) => {
    const parent = path.resolve('tests/tmp');
    mkdirSync(parent, { recursive: true });
    const directory = mkdtempSync(path.join(parent, 'overlapping-coverage-'));
    t.onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
    const definition = loadDefinition();
    const { coverage } = definition.subjects.find(({ subjectId }) => subjectId === 'subject.repository.action-distribution')
      .segments.find(({ id }) => id === 'integration-gates');
    const source = 'runtime/repository/check-provider-references.mjs';
    coverage.exclude = coverage.exclude.filter(entry => entry !== source);
    const input = path.join(directory, 'definition.json');
    writeFileSync(input, JSON.stringify(definition));
    const result = spawnSync(process.execPath, ['tests/coverage-tools/contract-subject-coverage.mjs', '--check', '--definition', input], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`coverage source ${path.normalize(source)} belongs to multiple instrumentation groups`);
  });

  test('execution rejects an unfiltered segment when all tests are skipped', (t) => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    mkdirSync(path.join(root, 'tests/tmp'), { recursive: true });
    const directory = mkdtempSync(path.join(root, 'tests/tmp/skipped-segment-'));
    t.onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
    const fixture = path.join(directory, 'skipped.test.mjs');
    writeFileSync(fixture, "import { test } from 'vitest'; test.skip('unavailable', () => {});\n");
    const subject = { subjectId: 'fixture', segments: [
      { id: 'unfiltered', level: 'e2e', cwd: '.', tests: [path.relative(root, fixture)] },
    ] };
    expect(() => collectSubjectCoverage(subject, root, directory)).toThrow('fixture/unfiltered: no selected tests passed');
    const measured = { ...subject, segments: [{
      ...subject.segments[0], id: 'measured', level: 'unit',
      coverage: { enabled: true, include: ['runtime/platform/source-text.mjs'], exclude: [] },
    }] };
    expect(() => collectSubjectCoverage(measured, root, directory)).toThrow('no selected tests passed');
    expect(existsSync(path.join(directory, 'fixture/measured.lcov'))).toBe(false);
  });

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

  // evidence_role: supplemental
  // Accepting the repository execution definition with every test path inside the repository is an implementation safety check that no contract guarantee covers.
  // flow_id: repository-contract-subject-execution
  test('definition check accepts the repository execution definition with tests inside the repository', () => {
    // Arrange
    const contractCore = path.resolve('sdd/dsl/specs/contract-core');
    const packageSubjects = [...readFileSync(path.join(contractCore, 'contract-package.sdd.yml'), 'utf8').matchAll(/^\s*- (subjects\/\S+\/)\s*$/gm)];
    // Act
    const result = spawnSync(process.execPath, ['tests/coverage-tools/contract-subject-coverage.mjs', '--check'], { encoding: 'utf8' });
    // Assert
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(`Execution definition is valid (${packageSubjects.length} contract subjects).`);
    expect(result.stderr).not.toContain('ci-failure-diagnostic:');
  });

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
