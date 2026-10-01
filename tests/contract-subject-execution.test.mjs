import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { aggregateCoverageMaps, loadDefinition, parseLcov, validateDefinition } from '../runtime/contract-subject-coverage.mjs';

// integration_id: repository-contract-subject-execution
test('project execution definition resolves every declared contract subject', () => {
  // Arrange
  const subjectId = 'subject.ci.platform-matrix';
  // Act
  const definition = loadDefinition();
  const platform = definition.subjects.find((subject) => subject.subjectId === subjectId);
  const composite = definition.subjects.find((subject) => subject.subjectId === 'subject.ci.github-toolchain-verifier');
  const materialization = definition.subjects.find((subject) => subject.subjectId === 'subject.ci.preset-materialization');
  const presetAssurance = definition.subjects.find((subject) => subject.subjectId === 'subject.ci.preset-assurance');
  const workflow = definition.subjects.find((subject) => subject.subjectId === 'subject.ci.quality-workflow');
  const managedSource = definition.subjects.find((subject) => subject.subjectId === 'subject.repository.managed-source-integrity');
  const actionDistribution = definition.subjects.find((subject) => subject.subjectId === 'subject.repository.action-distribution');
  // Assert
  assert.deepEqual(
    platform.segments.map((segment) => [segment.id, segment.level, segment.status ?? 'active']),
    [
      ['unit-source', 'unit', 'active'],
      ['integration-bundle', 'integration', 'active'],
      ['e2e', 'e2e', 'excluded'],
    ],
  );
  assert.deepEqual(platform.segments[0].coverage.include, ['src/**/*.ts']);
  assert.deepEqual(platform.segments[1].coverage.include, ['dist/**/*.js']);
  assert.equal(definition.report.unit, 'contract-subject-and-execution-segment');
  assert.equal(composite.segments[1].coverage.enabled, false);
  assert.match(composite.segments[1].coverage.reason, /shell implementation/);
  assert.deepEqual(materialization.segments[1].tests, ['../adapter/tests/materialize-adapter-bundle.test.mjs', '../adapter/tests/standard-quality-footprint.test.mjs']);
  assert.deepEqual(presetAssurance.segments[1].tests, [
    'tests/preset-assurance-contract.test.mjs',
    'tests/preset-validation-contract.test.mjs',
    'tests/action-availability.test.mjs',
    'tests/publication-validation.test.mjs',
    'tests/quality-platform-selection.test.mjs',
  ]);
  assert.deepEqual(workflow.segments[1].tests, ['tests/workflow-contracts.test.mjs']);
  assert.deepEqual(managedSource.segments[1].tests, [
    'tests/repository-managed-source-integrity.test.mjs',
    'tests/contract-subject-execution.test.mjs',
  ]);
  assert.ok(actionDistribution.segments[1].tests.includes('runtime/repository/tests/update-release-aliases.test.mjs'));
});

// integration_id: repository-contract-subject-execution
test('execution definition covers every contract-package subject scope', () => {
  // Arrange
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const definition = loadDefinition();
  const contractPackage = readFileSync(
    path.join(projectRoot, 'sdd/dsl/specs/contract-core/contract-package.sdd.yml'),
    'utf8',
  );
  // Act
  const packageSubjects = [...contractPackage.matchAll(/^\s*- subject_id:\s*(\S+)\s*$/gm)].map((match) => match[1]);
  const executionSubjects = definition.subjects.map((subject) => subject.subjectId);
  // Assert
  assert.deepEqual([...executionSubjects].sort(), [...packageSubjects].sort());
});

// target_id: parseLcov(string)
test('LCOV report is reduced to separate C0, C1, and line metrics', () => {
  // Arrange
  const lcov = [
    'SF:src/example.ts',
    'FNF:4',
    'FNH:3',
    'BRF:6',
    'BRH:5',
    'LF:10',
    'LH:8',
    'end_of_record',
  ].join('\n');
  // Act
  const result = parseLcov(lcov);
  // Assert
  assert.deepEqual(result.metrics, {
    C0: {
      covered: null,
      total: null,
      percentage: null,
      acquisitionStatus: 'unavailable',
      unavailableReason: 'Node LCOV exposes function counts, not statement counts; line coverage is not substituted for C0.',
    },
    C1: { covered: 5, total: 6, percentage: 83.33, acquisitionStatus: 'available', unavailableReason: null },
    line: { covered: 8, total: 10, percentage: 80, acquisitionStatus: 'available', unavailableReason: null },
  });
});

// target_id: aggregateCoverageMaps(coverageMaps, root)
test('coverage aggregate sums per-file counters within one instrumentation group', () => {
  // Arrange
  const root = path.resolve('/repo');
  const sourceGroup = {
    groupId: 'subject/a/source',
    levels: ['unit', 'integration'],
    scope: 'source',
    cwd: path.resolve('/repo/actions/x'),
    files: [{ sourceFile: 'src/a.ts', branches: { hit: 3, total: 4 }, lines: { hit: 9, total: 10 } }],
  };
  const distGroup = {
    groupId: 'subject/a/dist',
    levels: ['integration'],
    scope: 'dist',
    cwd: path.resolve('/repo/actions/x'),
    files: [{ sourceFile: 'dist/index.js', branches: { hit: 1, total: 1 }, lines: { hit: 2, total: 2 } }],
  };
  // Act
  const result = aggregateCoverageMaps([sourceGroup, distGroup], root);
  // Assert
  assert.deepEqual(result.metricSemantics, { C0: 'statement', C1: 'branch', line: 'line' });
  assert.deepEqual(result.byScope.source.levels, ['integration', 'unit']);
  assert.deepEqual(result.byScope.source.metrics.C1, { covered: 3, total: 4, percentage: 75 });
  assert.deepEqual(result.byScope.source.files, [{
    path: 'actions/x/src/a.ts',
    C1: { covered: 3, total: 4, percentage: 75 },
    line: { covered: 9, total: 10, percentage: 90 },
  }]);
  assert.deepEqual(result.byScope.dist.metrics.C1, { covered: 1, total: 1, percentage: 100 });
});

// target_id: aggregateCoverageMaps(coverageMaps, root)
test('coverage aggregate rejects a file observed by more than one instrumentation group', () => {
  // Arrange
  const root = path.resolve('/repo');
  const firstGroup = {
    groupId: 'subject/a/source',
    levels: ['unit'],
    scope: 'source',
    cwd: path.resolve('/repo/actions/x'),
    files: [{ sourceFile: 'src/a.ts', branches: { hit: 1, total: 1 }, lines: { hit: 1, total: 1 } }],
  };
  const secondGroup = { ...firstGroup, groupId: 'subject/b/source' };
  let failure;
  // Act
  try { aggregateCoverageMaps([firstGroup, secondGroup], root); } catch (error) { failure = error; }
  // Assert
  assert.match(String(failure), /cannot merge .* across instrumentation groups/);
});

// integration_id: repository-contract-subject-execution
test('definition rejects a test path that escapes the repository', () => {
  // Arrange
  const definition = loadDefinition();
  const invalid = structuredClone(definition);
  invalid.subjects[0].segments.find((segment) => segment.status !== 'excluded').tests = ['../../../../outside.test.mjs'];
  let failure;
  // Act
  try { validateDefinition(invalid); } catch (error) { failure = error; }
  // Assert
  assert.match(String(failure), /test path must resolve inside project root/);
});

// integration_id: repository-contract-subject-execution
test('definition rejects an active segment without an execution test', () => {
  // Arrange
  const definition = loadDefinition();
  const invalid = structuredClone(definition);
  invalid.subjects[0].segments.find((segment) => segment.status !== 'excluded').tests = [];
  let failure;
  // Act
  try { validateDefinition(invalid); } catch (error) { failure = error; }
  // Assert
  assert.match(String(failure), /tests are required/);
});
