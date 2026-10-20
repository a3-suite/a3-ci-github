import { existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { aggregateCoverageMaps, assertSourceCoverageFiles, loadDefinition, parseLcov, selectUnitIntegrationTests, validateDefinition } from './coverage-tools/contract-subject-coverage.mjs';
import { collectActions, collectScriptBundles } from '../runtime/repository/check-action-dist.mjs';

describe('selectUnitIntegrationTests(definition, discoveredTests, root)', () => {
  // target_id: selectUnitIntegrationTests(definition, discoveredTests, root)
  // evidence_role: supplemental
  // test_level: unit
  test('uses execution levels rather than filenames and retains maintenance tests', () => {
    // Arrange
    const root = path.resolve('/repo');
    const definition = { subjects: [{ segments: [
      { level: 'unit', cwd: 'component', tests: ['../unit.test.mjs'] },
      { level: 'integration', cwd: '.', tests: ['integration.test.ts'] },
      { level: 'e2e', cwd: 'component', tests: ['../ordinary-name.test.mjs'] },
      { level: 'e2e', status: 'excluded', reason: 'Hosted only' },
    ] }] };
    const tests = ['unit.test.mjs', 'integration.test.ts', 'ordinary-name.test.mjs', 'maintenance.test.mjs'];
    // Act
    const selected = selectUnitIntegrationTests(definition, tests, root);
    // Assert
    expect(selected).toStrictEqual(['unit.test.mjs', 'integration.test.ts', 'maintenance.test.mjs']);
  });

  // target_id: selectUnitIntegrationTests(definition, discoveredTests, root)
  // evidence_role: supplemental
  // test_level: unit
  test('rejects files shared between measured levels and E2E', () => {
    // Arrange
    const root = path.resolve('/repo');
    const definition = { subjects: [{ segments: [
      { level: 'integration', cwd: '.', tests: ['mixed.test.mjs'] },
      { level: 'e2e', cwd: 'nested', tests: ['../mixed.test.mjs'] },
    ] }] };
    // Act
    const select = () => selectUnitIntegrationTests(definition, ['mixed.test.mjs'], root);
    // Assert
    expect(select).toThrow(/test file mixes E2E with measured levels/);
  });
});


describe('repository-contract-subject-execution', () => {
  // integration_id: repository-contract-subject-execution
  // evidence_role: supplemental
  // test_level: integration
  test('default source measurement separates project E2E and preserves all maintenance files', () => {
    // Arrange
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const tests = globSync(['actions/*/tests/**/*.test.{ts,mjs}', 'runtime/*/tests/**/*.test.{ts,mjs}', 'tests/*.test.mjs'], { cwd: root });
    const definition = loadDefinition();
    const segments = definition.subjects.flatMap((subject) => subject.segments
      .filter((segment) => segment.status !== 'excluded'));
    const registered = new Set(segments.flatMap((segment) => segment.tests
      .map((file) => path.relative(root, path.resolve(root, segment.cwd, file)))));
    const e2e = new Set(segments.filter((segment) => segment.level === 'e2e')
      .flatMap((segment) => segment.tests.map((file) => path.relative(root, path.resolve(root, segment.cwd, file)))));
    const expected = tests.filter((file) => !e2e.has(file));
    // Act
    const selected = selectUnitIntegrationTests(definition, tests, root);
    // Assert
    expect(tests).toContain('tests/public-cli-lifecycle.test.mjs');
    expect(selected).not.toContain('tests/public-cli-lifecycle.test.mjs');
    expect(selected).not.toContain('runtime/repository/tests/single-release-binding.test.mjs');
    expect(selected).not.toContain('actions/ci-release-supplemental-asset/tests/standard-installer.test.ts');
    expect(selected).not.toContain('actions/ci-release-supplemental-asset/tests/standard-installer.e2e.test.ts');
    expect(selected).not.toContain('actions/ci-release-supplemental-asset/tests/entrypoint.test.ts');
    expect(selected).not.toContain('runtime/installer/tests/common-regression.test.mjs');
    for (const file of tests.filter((file) => /^actions\/[^/]+\/tests\/entrypoint\.test\.ts$/.test(file)
      || /^tests\/(action|runtime|workflow)-failure-diagnostics\.test\.mjs$/.test(file))) {
      expect(e2e.has(file), file).toBe(true);
      expect(selected, file).not.toContain(file);
    }
    expect(segments.filter((segment) => segment.level === 'e2e')
      .every((segment) => segment.coverage?.enabled !== true)).toBe(true);
    for (const file of tests.filter((file) => /\.process\.test\.(mjs|ts)$/.test(file))) {
      expect(e2e.has(file), file).toBe(true);
      expect(selected, file).not.toContain(file);
    }
    expect(selected.toSorted()).toStrictEqual(expected.toSorted());
    const maintenance = tests.filter((file) => !registered.has(file));
    expect(maintenance).toContain('tests/cli-specification.test.mjs');
    for (const file of ['tests/release-token-capability-probe.test.mjs', 'runtime/repository/tests/contract-coverage-aggregation.process.test.mjs']) {
      expect(e2e.has(file), file).toBe(true);
      expect(selected, file).not.toContain(file);
    }
    expect(selected).toContain('runtime/repository/tests/contract-coverage-aggregation.test.mjs');
    expect(maintenance.every((file) => selected.includes(file))).toBe(true);
  });
});


describe("repository-contract-subject-execution", () => {
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
    expect(platform.segments.map((segment) => [segment.id, segment.level, segment.status ?? 'active'])).toStrictEqual([
        ['unit-source', 'unit', 'active'],
        ['e2e-source-entrypoint', 'e2e', 'active'],
        ['integration-bundle', 'integration', 'active'],
        ['e2e-bundle-process', 'e2e', 'active'],
        ['e2e-diagnostics', 'e2e', 'active'],
        ['integration-shared-trust', 'integration', 'active'],
        ['e2e-shared-trust-boundary', 'e2e', 'active'],
      ]);
    expect(platform.segments[0].coverage.include).toStrictEqual(['src/**/*.ts']);
    expect(platform.segments[2].coverage.include).toStrictEqual(['dist/**/*.js']);
    for (const subject of definition.subjects) {
      for (const segment of subject.segments.filter((entry) => entry.coverage?.scope === 'dist')) {
        expect(segment.coverage.enabled, `${subject.subjectId}/${segment.id}`).toBe(false);
        expect(segment.coverage.reason).toMatch(/source-only/);
        if (segment.status !== 'excluded') expect(segment.tests.length > 0).toBeTruthy();
      }
    }
    expect(definition.report.unit).toBe('contract-subject-and-execution-segment');
    expect(composite.segments[1].coverage.enabled).toBe(false);
    expect(composite.segments[1].level).toBe('e2e');
    expect(materialization.segments[1].tests).toStrictEqual(['../adapter/tests/materialize-adapter-bundle.test.mjs', '../adapter/tests/generate-standard-quality-bundles.test.mjs']);
    expect(presetAssurance.segments[1].tests).toStrictEqual([
      'tests/preset-validation-contract.test.mjs',
      'tests/action-availability.test.mjs',
      'tests/publication-validation.test.mjs',
      'tests/quality-platform-selection.test.mjs',
      'tests/standard-quality-bundles.test.mjs',
      'tests/reusable-quality-workflow.test.mjs',
    ]);
    for (const subject of [workflow, packageWorkflow]) {
      const segment = subject.segments.find((entry) => entry.id === 'integration-contract');
      expect(segment.cwd).toBe('runtime/preset');
      expect(segment.typescript).toBe(true);
      expect(segment.tests).toStrictEqual([
        '../../tests/workflow-contracts.test.mjs',
        'tests/reusable-quality-workflow.test.mjs',
      ]);
    }
    expect(managedSource.segments[1].tests).toStrictEqual([
      'tests/repository-managed-source-integrity.test.mjs',
      'tests/contract-subject-execution.test.mjs',
    ]);
    expect(actionDistribution.segments[1].tests.includes('runtime/repository/tests/update-release-aliases.test.mjs')).toBeTruthy();
  });

  // integration_id: repository-contract-subject-execution
  test('execution definition covers every contract-package subject scope', () => {
    // Arrange
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const definition = loadDefinition();
    const contractCore = path.join(projectRoot, 'sdd/dsl/specs/contract-core');
    const contractPackage = readFileSync(path.join(contractCore, 'contract-package.sdd.yml'), 'utf8');
    // Act
    const packageSubjects = [...contractPackage.matchAll(/^\s*- path:\s*(subjects\/\S+\/)\s*$/gm)]
      .map((match) => readFileSync(path.join(contractCore, match[1], 'subject.sdd.yml'), 'utf8').match(/^subject:\n {2}id:\s*(\S+)\s*$/m)[1]);
    const executionSubjects = definition.subjects.map((subject) => subject.subjectId);
    // Assert
    expect([...executionSubjects].sort()).toStrictEqual([...packageSubjects].sort());
  });
});


describe("parseLcov(string)", () => {
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
    expect(result.metrics).toStrictEqual({
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
});


describe("aggregateCoverageMaps(coverageMaps, root)", () => {
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
    // Act
    const result = aggregateCoverageMaps([sourceGroup], root);
    // Assert
    expect(result.metricSemantics).toStrictEqual({ C0: 'statement', C1: 'branch', line: 'line' });
    expect(result.byScope.source.levels).toStrictEqual(['integration', 'unit']);
    expect(result.byScope.source.metrics.C1).toStrictEqual({ covered: 3, total: 4, percentage: 75 });
    expect(result.byScope.source.files).toStrictEqual([{
      path: 'actions/x/src/a.ts',
      C1: { covered: 3, total: 4, percentage: 75 },
      line: { covered: 9, total: 10, percentage: 90 },
    }]);
  });

  // target_id: aggregateCoverageMaps(coverageMaps, root)
  test('coverage aggregate rejects distribution scopes', () => {
    // Arrange
    const root = path.resolve('/repo');
    const distGroup = { groupId: 'subject/a/dist', scope: 'dist', cwd: root, files: [] };
    let failure;
    // Act
    try { aggregateCoverageMaps([distGroup], root); } catch (error) { failure = error; }
    // Assert
    expect(String(failure)).toMatch(/source-only/);
  });
});


describe("assertSourceCoverageFiles(root, files)", () => {
  // target_id: assertSourceCoverageFiles(root, files)
  test('source coverage does not reject an undeclared distribution directory by name alone', () => {
    // Arrange
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    mkdirSync(path.join(projectRoot, 'tmp'), { recursive: true });
    const directory = mkdtempSync(path.join(projectRoot, 'tmp/source-named-dist-'));
    try {
      const source = path.join(directory, 'dist/source.mjs');
      mkdirSync(path.dirname(source));
      writeFileSync(source, 'export const value = 1;\n');
      let failure;
      // Act
      try { assertSourceCoverageFiles(directory, [source]); } catch (error) { failure = error; }
      // Assert
      expect(failure).toBe(undefined);
      const actionRoot = path.join(directory, 'actions/sample');
      const runtimeRoot = path.join(directory, 'runtime/rust-release');
      mkdirSync(path.join(actionRoot, 'src'), { recursive: true });
      mkdirSync(path.join(runtimeRoot, 'src'), { recursive: true });
      writeFileSync(path.join(actionRoot, 'action.yml'), 'name: sample\nruns:\n  using: node24\n  main: dist/index.js\n');
      writeFileSync(path.join(actionRoot, 'src/index.ts'), 'export const value = 1;\n');
      writeFileSync(path.join(runtimeRoot, 'src/verify-platform-manifest.mjs'), 'export const value = 1;\n');
      // Act
      assertSourceCoverageFiles(directory, [path.join(actionRoot, 'src/index.ts'), path.join(runtimeRoot, 'src/verify-platform-manifest.mjs')]);
      // Assert
      expect(existsSync(path.join(actionRoot, 'dist'))).toBe(false);
      expect(existsSync(path.join(runtimeRoot, 'dist'))).toBe(false);
      for (const bundle of [path.join(actionRoot, 'dist/index.js'), path.join(runtimeRoot, 'dist/index.mjs')]) {
        expect(() => assertSourceCoverageFiles(directory, [bundle])).toThrow(/source-only.*generated distribution/);
      }
      writeFileSync(path.join(actionRoot, 'README.md'), '# Sample\n');
      writeFileSync(path.join(actionRoot, 'package.json'), '{}\n');
      writeFileSync(path.join(runtimeRoot, 'package.json'), '{}\n');
      expect(() => collectActions(directory)).toThrow(/missing dist\/index.js/);
      expect(() => collectScriptBundles(directory)).toThrow(/missing dist\/index.mjs/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});


describe("repository-contract-subject-execution", () => {
  // integration_id: repository-contract-subject-execution
  test('definition rejects enabled distribution coverage while retaining bundle execution', () => {
    // Arrange
    const invalid = structuredClone(loadDefinition());
    const segment = invalid.subjects.flatMap((subject) => subject.segments)
      .find((entry) => entry.coverage?.scope === 'dist' && entry.status !== 'excluded');
    segment.coverage.enabled = true;
    let failure;
    // Act
    try { validateDefinition(invalid); } catch (error) { failure = error; }
    // Assert
    expect(String(failure)).toMatch(/source-only/);
  });
});


describe("aggregateCoverageMaps(coverageMaps, root)", () => {
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
    expect(String(failure)).toMatch(/cannot merge .* across instrumentation groups/);
  });
});


describe("repository-contract-subject-execution", () => {
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
    expect(String(failure)).toMatch(/test path must resolve inside project root/);
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
    expect(String(failure)).toMatch(/tests are required/);
  });

  // integration_id: repository-contract-subject-execution
  test('Action source entrypoint observations belong to E2E without source coverage', () => {
    // Arrange
    const definition = loadDefinition();
    const entrypoints = definition.subjects.flatMap((subject) => subject.segments
      .filter((segment) => segment.id === 'e2e-source-entrypoint')
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
      .map((file) => path.dirname(path.dirname(file)))
      .filter((root) => root !== 'actions/ci-release-supplemental-asset').sort();
    const supplemental = definition.subjects.find((subject) => subject.subjectId === 'subject.ci.release-supplemental-asset');
    expect(supplemental.segments.find((segment) => segment.level === 'e2e').tests).toContain('tests/entrypoint.test.ts');
    expect(observations.map((observation) => observation.cwd).sort()).toStrictEqual(actionRoots);
    for (const observation of observations) {
      expect(observation.cwd).toBe(observation.expectedCwd);
      expect(observation.level).toBe('e2e');
      expect(observation.scope).toBe('source');
      expect(observation.tests).toStrictEqual(['tests/entrypoint.test.ts']);
      expect(observation.include).toStrictEqual(['src/index.ts']);
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
    expect(() => aggregateCoverageMaps(maps, projectRoot)).not.toThrow();
  });
});
