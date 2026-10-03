import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'vitest';
import { collectSubjectCoverage } from '../../../tests/coverage-tools/contract-subject-coverage.mjs';

// integration_id: repository-coverage-aggregation
// evidence_role: supplemental
// test_level: integration
test('non-measured segments execute only the selected checkout test set', () => {
  // Arrange
  const temporaryRoot = path.resolve('tests/tmp');
  mkdirSync(temporaryRoot, { recursive: true });
  const root = mkdtempSync(path.join(temporaryRoot, 'coverage-selected-checkout-'));
  try {
    mkdirSync(path.join(root, 'custom'));
    writeFileSync(path.join(root, 'custom/selected.test.mjs'), "import { test } from 'vitest'; import { writeFileSync } from 'node:fs'; test('selected checkout', () => writeFileSync(new URL('./executed', import.meta.url), 'selected'));\n");
    writeFileSync(path.join(root, 'custom/unselected.test.mjs'), "throw new Error('unselected test must not run');\n");
    const subject = { subjectId: 'selected', segments: [{ id: 'observations', level: 'integration', cwd: 'custom', tests: ['selected.test.mjs'], coverage: { enabled: false } }] };
    const reportRoot = path.join(root, 'reports');
    const planned = collectSubjectCoverage(subject, root, reportRoot, true);
    assert.equal(planned.segments[0].status, 'planned');
    assert.equal(existsSync(reportRoot), false);
    // Act
    const result = collectSubjectCoverage(subject, root, reportRoot);
    // Assert
    assert.equal(result.segments[0].status, 'passed');
    assert.equal(readFileSync(path.join(root, 'custom/executed'), 'utf8'), 'selected');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// integration_id: repository-coverage-aggregation
// evidence_role: supplemental
// test_level: integration
test('shared runtime aggregate combines different subject paths in one instrumentation group', () => {
  // Arrange
  const temporaryRoot = path.resolve('tests/tmp');
  mkdirSync(temporaryRoot, { recursive: true });
  const root = mkdtempSync(path.join(temporaryRoot, 'coverage-group-'));
  try {
    mkdirSync(path.join(root, 'shared'));
    writeFileSync(path.join(root, 'shared/core.cjs'), 'exports.choose = (value) => value ? 1 : 0;\n');
    const subjects = ['first', 'second'].map((name, index) => {
      mkdirSync(path.join(root, name));
      writeFileSync(path.join(root, name, 'core.test.mjs'), `import { test } from 'vitest'; import assert from 'node:assert/strict'; import { choose } from '../shared/core.cjs'; test('chooses ${index}', () => assert.equal(choose(${index === 1}), ${index}));\n`);
      return { subjectId: name, segments: [{
        id: 'source', level: 'unit', cwd: name, tests: ['core.test.mjs'],
        coverage: { enabled: true, scope: 'source', aggregateGroup: 'shared-runtime', include: ['../shared/core.cjs'], exclude: [] },
      }] };
    });
    const collectorUrl = new URL('../../../tests/coverage-tools/contract-subject-coverage.mjs', import.meta.url).href;
    const environment = { ...process.env };
    delete environment.NODE_TEST_CONTEXT;
    // Act
    const execution = spawnSync(process.execPath, ['--input-type=module', '--eval',
      `import { collectAggregateCoverage } from ${JSON.stringify(collectorUrl)}; const [subjects, root] = JSON.parse(process.argv[1]); console.log(JSON.stringify(collectAggregateCoverage(subjects, root, root + '/coverage')));`,
      JSON.stringify([subjects, root]),
    ], { encoding: 'utf8', env: environment });
    // Assert
    assert.equal(execution.status, 0, execution.stderr);
    const result = JSON.parse(execution.stdout);
    assert.deepEqual(result.byScope.source.files.map((file) => file.path), ['shared/core.cjs']);
    assert.equal(result.byScope.source.metrics.C1.percentage, 100);
    assert.equal(result.byScope.source.metrics.line.percentage, 100);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


for (const format of ['module', 'commonjs']) {
  // integration_id: repository-coverage-aggregation
  // evidence_role: supplemental
  // test_level: integration
  test(`TypeScript ${format} measurement preserves uncovered and unloaded source in both report paths`, () => {
    // Arrange
    const temporaryRoot = path.resolve('tests/tmp');
    mkdirSync(temporaryRoot, { recursive: true });
    const root = mkdtempSync(path.join(temporaryRoot, 'coverage-typescript-'));
    try {
      writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: format }));
      symlinkSync(new URL('../../../tests/coverage-tools/node_modules', import.meta.url), path.join(root, 'node_modules'), 'dir');
      writeFileSync(path.join(root, 'core.ts'), [
        'export function choose(value: boolean): number {',
        '  if (value === true) {',
        '    return 1;',
        '  }',
        '  if (value === false) {',
        '    return 0;',
        '  }',
        '  throw new Error("unused");',
        '}',
        'export const moduleUrl = import.meta.url;',
      ].join('\n') + '\n');
      writeFileSync(path.join(root, 'unloaded.ts'), [
        'export const unused = (value: boolean) => {',
        '  const callbacks = { run: () => { return value ? 1 : 0; } };',
        '  try {',
        '    return callbacks.run();',
        '  } catch (error) {',
        '    throw error;',
        '  }',
        '};',
      ].join('\n') + '\n');
      writeFileSync(path.join(root, 'imported.test.ts'), "import { test } from 'vitest'; import './unloaded.js'; test('loads without calling', () => {});\n");
      writeFileSync(path.join(root, 'partial.test.ts'), "import { test } from 'vitest'; import assert from 'node:assert/strict'; import { choose } from './core.js'; test('partial', () => { assert.equal(choose(true), 1); assert.equal(choose(false), 0); });\n");
      writeFileSync(path.join(root, 'complete.test.ts'), "import { test } from 'vitest'; import assert from 'node:assert/strict'; import { choose } from './core.js'; test('remaining branch', () => assert.throws(() => choose(null as unknown as boolean), /unused/));\n");
      const subject = (id, tests, include) => ({ subjectId: id, segments: [{
        id: 'source', level: 'unit', cwd: '.', typescript: true, tests,
        coverage: { enabled: true, scope: 'source', include, exclude: [] },
      }] });
      const subjects = [
        subject('partial', ['partial.test.ts'], ['core.ts']),
        subject('complete', ['partial.test.ts', 'complete.test.ts'], ['core.ts']),
        subject('unloaded', ['partial.test.ts'], ['unloaded.ts']),
        subject('imported', ['imported.test.ts'], ['unloaded.ts']),
      ];
      const collectorUrl = new URL('../../../tests/coverage-tools/contract-subject-coverage.mjs', import.meta.url).href;
      const environment = { ...process.env };
      delete environment.NODE_TEST_CONTEXT;
      // Act
      const execution = spawnSync(process.execPath, ['--input-type=module', '--eval',
        `import { collectSubjectCoverage, collectAggregateCoverage } from ${JSON.stringify(collectorUrl)}; const [subjects, root] = JSON.parse(process.argv[1]); console.log(JSON.stringify(subjects.map(subject => ({ id: subject.subjectId, individual: collectSubjectCoverage(subject, root, root + '/coverage'), aggregate: collectAggregateCoverage([subject], root, root + '/coverage') }))));`,
        JSON.stringify([subjects, root]),
      ], { encoding: 'utf8', env: environment });
      // Assert
      assert.equal(execution.status, 0, execution.stderr);
      const results = JSON.parse(execution.stdout);
      for (const result of results) {
        const individual = result.individual.segments[0].coverage.metrics;
        const aggregate = result.aggregate.byScope.source.metrics;
        assert.equal(individual.C1.percentage, aggregate.C1.percentage);
        assert.equal(individual.line.percentage, aggregate.line.percentage);
      }
      assert.equal(results[0].individual.segments[0].coverage.metrics.C1.percentage, 75);
      assert.equal(results[0].individual.segments[0].coverage.metrics.line.total, 6);
      assert.equal(results[0].individual.segments[0].coverage.metrics.line.covered, 5);
      assert.equal(results[0].individual.segments[0].coverage.metrics.line.percentage, 83.33);
      assert.match(readFileSync(path.join(root, 'coverage/partial/source.lcov'), 'utf8'), /^DA:8,0$/m);
      assert.equal(results[1].individual.segments[0].coverage.metrics.C1.percentage, 100);
      assert.equal(results[1].individual.segments[0].coverage.metrics.line.percentage, 100);
      const unloaded = results[2].aggregate.byScope.source.files.find((file) => file.path === 'unloaded.ts');
      assert.ok(unloaded.C1.total > 0);
      assert.ok(unloaded.line.total > 0);
      assert.equal(unloaded.C1.percentage, 0);
      assert.equal(unloaded.line.percentage, 0);
      const unloadedLcov = readFileSync(path.join(root, 'coverage/unloaded/source.lcov'), 'utf8');
      const importedLcov = readFileSync(path.join(root, 'coverage/imported/source.lcov'), 'utf8');
      const denominator = (lcov) => lcov.split('\n').filter((line) => /^(?:FNF:|LF:|BRF:)/.test(line));
      assert.deepEqual(denominator(unloadedLcov), denominator(importedLcov));
      assert.match(unloadedLcov, /^FNF:2$/m);
      for (const line of [2, 4, 6]) assert.match(unloadedLcov, new RegExp(`^DA:${line},0$`, 'm'));
      for (const report of ['individual', 'aggregate']) {
        const metrics = (index) => report === 'individual'
          ? results[index].individual.segments[0].coverage.metrics
          : results[index].aggregate.byScope.source.metrics;
        assert.equal(metrics(2).line.total, metrics(3).line.total, `${report} unloaded line denominator`);
        assert.equal(metrics(2).C1.total, metrics(3).C1.total, `${report} unloaded branch denominator`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

// integration_id: repository-coverage-aggregation
// evidence_role: supplemental
// test_level: integration
test('Vitest observations merge source counters and preserve subprocess behavior', () => {
  // Arrange
  const temporaryRoot = path.resolve('tests/tmp');
  mkdirSync(temporaryRoot, { recursive: true });
  const root = mkdtempSync(path.join(temporaryRoot, 'coverage-mixed-loaders-'));
  try {
    symlinkSync(new URL('../../../tests/coverage-tools/node_modules', import.meta.url), path.join(root, 'node_modules'), 'dir');
    writeFileSync(path.join(root, 'core.mjs'), [
      'export const choose = (value) => {',
      '  return value ? 1 : 0;',
      '};',
      'export const unused = (value) => {',
      '  return value ? 2 : 3;',
      '};',
    ].join('\n') + '\n');
    writeFileSync(path.join(root, 'worker.mjs'), "import { parentPort } from 'node:worker_threads'; import { choose } from './core.mjs'; parentPort.postMessage(choose(false));\n");
    writeFileSync(path.join(root, 'child.mjs'), "import { choose } from './core.mjs'; console.log(choose(false));\n");
    writeFileSync(path.join(root, 'esm.test.mjs'), "import { test } from 'vitest'; import assert from 'node:assert/strict'; import { Worker } from 'node:worker_threads'; import { choose } from './core.mjs'; test('true and worker', async () => { assert.equal(choose(true), 1); const worker = new Worker(new URL('./worker.mjs', import.meta.url)); const value = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); }); assert.equal(value, 0); });\n");
    writeFileSync(path.join(root, 'second.test.mjs'), "import { test } from 'vitest'; import assert from 'node:assert/strict'; import { spawnSync } from 'node:child_process'; import { choose } from './core.mjs'; test('false and child', () => { assert.equal(choose(false), 0); const child = spawnSync(process.execPath, ['child.mjs'], { encoding: 'utf8' }); assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout.trim(), '0'); });\n");
    const subject = { subjectId: 'mixed', segments: [{
      id: 'source', level: 'integration', cwd: '.', typescript: true,
      tests: ['esm.test.mjs', 'second.test.mjs'],
      coverage: { enabled: true, scope: 'source', include: ['core.mjs'], exclude: [] },
    }] };
    const collectorUrl = new URL('../../../tests/coverage-tools/contract-subject-coverage.mjs', import.meta.url).href;
    const environment = { ...process.env };
    delete environment.NODE_TEST_CONTEXT;
    // Act
    const execution = spawnSync(process.execPath, ['--input-type=module', '--eval',
      `import { collectSubjectCoverage, collectAggregateCoverage } from ${JSON.stringify(collectorUrl)}; const [subject, root] = JSON.parse(process.argv[1]); console.log(JSON.stringify({ individual: collectSubjectCoverage(subject, root, root + '/coverage'), aggregate: collectAggregateCoverage([subject], root, root + '/coverage') }));`,
      JSON.stringify([subject, root]),
    ], { encoding: 'utf8', env: environment });
    // Assert
    assert.equal(execution.status, 0, execution.stderr);
    const results = JSON.parse(execution.stdout);
    const lcov = readFileSync(path.join(root, 'coverage/mixed/source.lcov'), 'utf8');
    assert.match(lcov, /^FNF:2$/m);
    assert.match(lcov, /^FNH:1$/m);
    assert.match(lcov, /^BRF:4$/m);
    assert.match(lcov, /^BRH:2$/m);
    assert.match(lcov, /^DA:5,0$/m);
    assert.equal(results.individual.segments[0].coverage.metrics.C1.percentage, 50);
    assert.equal(results.aggregate.byScope.source.metrics.C1.percentage, 50);
    for (const reportPath of [path.join(root, 'coverage/mixed/source.lcov.json'), path.join(root, 'coverage/aggregate/mixed/source.lcov.json')]) {
      const counters = JSON.parse(readFileSync(reportPath, 'utf8'))[path.join(root, 'core.mjs')];
      assert.deepEqual(Object.values(counters.f), [4, 0]);
      assert.deepEqual(Object.values(counters.b), [[1, 3], [0, 0]]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// integration_id: repository-coverage-aggregation
// evidence_role: supplemental
// test_level: integration
test('coverage capture publishes complete snapshots and distinguishes interrupted writes', () => {
  // Arrange
  const temporaryRoot = path.resolve('tests/tmp');
  mkdirSync(temporaryRoot, { recursive: true });
  const root = mkdtempSync(path.join(temporaryRoot, 'coverage-snapshot-'));
  const capture = new URL('../../../tests/coverage-tools/capture-coverage.mjs', import.meta.url);
  const config = path.join(root, 'capture.json');
  writeFileSync(config, JSON.stringify({ scripts: { fixture: '' }, rawDirectory: root, typescript: false }));
  const env = { ...process.env, A3_CI_COVERAGE_CONFIG: config, NODE_OPTIONS: '' };
  const run = (code) => spawnSync(process.execPath, ['--import', capture.href, '--input-type=module', '--eval', code], { env, encoding: 'utf8' });
  try {
    // Act
    const empty = run('');
    const complete = run('globalThis.__coverage__ = { fixture: { observed: true } };');
    // Assert
    assert.equal(empty.status, 0, empty.stderr);
    assert.equal(complete.status, 0, complete.stderr);
    assert.equal(existsSync(path.join(root, `${empty.pid}-0.json`)), false);
    assert.deepEqual(JSON.parse(readFileSync(path.join(root, `${complete.pid}-0.json`), 'utf8')).coverage, { fixture: { observed: true } });
    assert.equal(readdirSync(root).some((filename) => filename.endsWith('.pending')), false);
    // Act
    const interrupted = run("import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module'; globalThis.__coverage__ = { fixture: { observed: true } }; const write = fs.writeFileSync; fs.writeFileSync = (destination) => { write(destination, '{'); throw new Error('simulated interrupted snapshot'); }; syncBuiltinESMExports();");
    // Assert
    assert.notEqual(interrupted.status, 0);
    assert.match(interrupted.stderr, /simulated interrupted snapshot/);
    assert.equal(existsSync(path.join(root, `${interrupted.pid}-0.json`)), false);
    assert.equal(readFileSync(path.join(root, `${interrupted.pid}-0.json.pending`), 'utf8'), '{');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
