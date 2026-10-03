import assert from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { aggregateCoverageMaps, loadDefinition, parseLcov, validateDefinition } from './coverage-tools/contract-subject-coverage.mjs';

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
  const packageWorkflow = definition.subjects.find((subject) => subject.subjectId === 'subject.ci.package-publication-workflow');
  const managedSource = definition.subjects.find((subject) => subject.subjectId === 'subject.repository.managed-source-integrity');
  const actionDistribution = definition.subjects.find((subject) => subject.subjectId === 'subject.repository.action-distribution');
  // Assert
  assert.deepEqual(
    platform.segments.map((segment) => [segment.id, segment.level, segment.status ?? 'active']),
    [
      ['unit-source', 'unit', 'active'],
      ['integration-source-entrypoint', 'integration', 'active'],
      ['integration-bundle', 'integration', 'active'],
      ['e2e', 'e2e', 'excluded'],
    ],
  );
  assert.deepEqual(platform.segments[0].coverage.include, ['src/**/*.ts']);
  assert.deepEqual(platform.segments[2].coverage.include, ['dist/**/*.js']);
  for (const subject of definition.subjects) {
    for (const segment of subject.segments.filter((entry) => entry.coverage?.scope === 'dist')) {
      assert.equal(segment.coverage.enabled, false, `${subject.subjectId}/${segment.id}`);
      assert.match(segment.coverage.reason, /source-only/);
      if (segment.status !== 'excluded') assert.ok(segment.tests.length > 0);
    }
  }
  assert.equal(definition.report.unit, 'contract-subject-and-execution-segment');
  assert.equal(composite.segments[1].coverage.enabled, false);
  assert.match(composite.segments[1].coverage.reason, /shell implementation/);
  assert.deepEqual(materialization.segments[1].tests, ['../adapter/tests/materialize-adapter-bundle.test.mjs', '../adapter/tests/standard-quality-footprint.test.mjs', '../adapter/tests/generate-standard-quality-bundles.test.mjs']);
  assert.deepEqual(presetAssurance.segments[1].tests, [
    'tests/preset-assurance-contract.test.mjs',
    'tests/preset-validation-contract.test.mjs',
    'tests/action-availability.test.mjs',
    'tests/publication-validation.test.mjs',
    'tests/quality-platform-selection.test.mjs',
    'tests/standard-quality-bundles.test.mjs',
    'tests/reusable-quality-workflow.test.mjs',
  ]);
  for (const subject of [workflow, packageWorkflow]) {
    const segment = subject.segments.find((entry) => entry.id === 'integration-contract');
    assert.equal(segment.cwd, 'runtime/preset');
    assert.equal(segment.typescript, true);
    assert.deepEqual(segment.tests, [
      '../../tests/workflow-contracts.test.mjs',
      'tests/reusable-quality-workflow.test.mjs',
    ]);
  }
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
      unavailableReason: 'LCOV exposes function counts, not statement counts; line coverage is not substituted for C0.',
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

// integration_id: repository-contract-subject-execution
test('Action source entrypoint observations belong to their own integration segment', () => {
  // Arrange
  const definition = loadDefinition();
  const entrypoints = definition.subjects.flatMap((subject) => subject.segments
    .filter((segment) => segment.id === 'integration-source-entrypoint')
    .map((segment) => ({ subject, segment })));
  // Act
  const observations = entrypoints.map(({ subject, segment }) => ({
    cwd: segment.cwd,
    expectedCwd: `actions/ci-${subject.subjectId.slice('subject.ci.'.length)}`,
    level: segment.level,
    scope: segment.coverage.scope,
    tests: segment.tests,
    include: segment.coverage.include,
  }));
  // Assert
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const actionRoots = globSync('actions/*/tests/entrypoint.test.ts', { cwd: projectRoot })
    .map((file) => path.dirname(path.dirname(file))).sort();
  assert.deepEqual(observations.map((observation) => observation.cwd).sort(), actionRoots);
  for (const observation of observations) {
    assert.equal(observation.cwd, observation.expectedCwd);
    assert.equal(observation.level, 'integration');
    assert.equal(observation.scope, 'source');
    assert.deepEqual(observation.tests, ['tests/entrypoint.test.ts']);
    assert.deepEqual(observation.include, ['src/index.ts']);
  }
});

// integration_id: repository-contract-subject-execution
test('source execution inventory has one instrumentation owner per file', () => {
  // Arrange
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const definition = loadDefinition();
  // Act
  const maps = definition.subjects.flatMap((subject) => subject.segments
    .filter((segment) => segment.status !== 'excluded' && segment.coverage?.enabled
      && segment.coverage.scope === 'source' && ['unit', 'integration'].includes(segment.level))
    .map((segment) => {
      const cwd = path.resolve(projectRoot, segment.cwd);
      const excluded = new Set(globSync(segment.coverage.exclude, { cwd }));
      return {
        groupId: `${segment.coverage.aggregateGroup ?? subject.subjectId}/source`,
        levels: [segment.level],
        scope: 'source',
        cwd,
        files: globSync(segment.coverage.include, { cwd }).filter((file) => !excluded.has(file))
          .map((sourceFile) => ({ sourceFile, branches: { hit: 0, total: 0 }, lines: { hit: 0, total: 0 } })),
      };
    }));
  // Assert
  assert.doesNotThrow(() => aggregateCoverageMaps(maps, projectRoot));
});
