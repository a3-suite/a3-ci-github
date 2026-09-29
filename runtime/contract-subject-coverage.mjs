import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DEFINITION = path.join(SCRIPT_ROOT, 'tests/contract-subject-execution.json');

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isRelativePath = (value) => typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && !value.split('/').includes('..');
const isInside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};

const ratio = (hit, total) => (total === 0 ? null : Number(((hit / total) * 100).toFixed(2)));
const availableMetric = (hit, total) => ({
  covered: hit,
  total,
  percentage: ratio(hit, total),
  acquisitionStatus: 'available',
  unavailableReason: null,
});
const unavailableMetric = (reason) => ({
  covered: null,
  total: null,
  percentage: null,
  acquisitionStatus: 'unavailable',
  unavailableReason: reason,
});
const unavailableCoverage = (reason) => ({
  C0: unavailableMetric(reason),
  C1: unavailableMetric(reason),
  line: unavailableMetric(reason),
});

export const parseLcov = (text) => {
  const files = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (line === 'end_of_record') {
      if (current) files.push(current);
      current = null;
      continue;
    }
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (key === 'SF') {
      current = { sourceFile: value, functions: { hit: 0, total: 0 }, branches: { hit: 0, total: 0 }, lines: { hit: 0, total: 0 } };
    } else if (current && key === 'FNH') current.functions.hit = Number(value);
    else if (current && key === 'FNF') current.functions.total = Number(value);
    else if (current && key === 'BRH') current.branches.hit = Number(value);
    else if (current && key === 'BRF') current.branches.total = Number(value);
    else if (current && key === 'LH') current.lines.hit = Number(value);
    else if (current && key === 'LF') current.lines.total = Number(value);
  }
  if (current) files.push(current);
  const total = (metric) => files.reduce((sum, file) => ({ hit: sum.hit + file[metric].hit, total: sum.total + file[metric].total }), { hit: 0, total: 0 });
  const branches = total('branches');
  const lines = total('lines');
  return {
    files,
    metrics: {
      C0: unavailableMetric('Node LCOV exposes function counts, not statement counts; line coverage is not substituted for C0.'),
      C1: availableMetric(branches.hit, branches.total),
      line: availableMetric(lines.hit, lines.total),
    },
  };
};

const validateSegment = (segment, subjectId, root) => {
  assert(isObject(segment), `${subjectId}: segment must be an object`);
  assert(typeof segment.id === 'string' && segment.id.length > 0, `${subjectId}: segment.id is required`);
  assert(['unit', 'integration', 'e2e'].includes(segment.level), `${subjectId}/${segment.id}: invalid level`);
  if (segment.status === 'excluded') {
    assert(typeof segment.reason === 'string' && segment.reason.length > 0, `${subjectId}/${segment.id}: excluded segment requires reason`);
    return;
  }
  assert(segment.status === undefined || segment.status === 'active', `${subjectId}/${segment.id}: invalid status`);
  assert(isRelativePath(segment.cwd), `${subjectId}/${segment.id}: cwd must be project-relative`);
  assert(Array.isArray(segment.tests) && segment.tests.length > 0, `${subjectId}/${segment.id}: tests are required`);
  for (const testPath of segment.tests) {
    assert(typeof testPath === 'string' && testPath.length > 0 && !path.isAbsolute(testPath), `${subjectId}/${segment.id}: test path must be cwd-relative`);
    const resolvedTestPath = path.resolve(root, segment.cwd, testPath);
    assert(isInside(root, resolvedTestPath), `${subjectId}/${segment.id}: test path must resolve inside project root`);
    assert(readFileSync(resolvedTestPath, 'utf8').length >= 0, `${subjectId}/${segment.id}: test is unreadable`);
  }
  assert(isObject(segment.coverage), `${subjectId}/${segment.id}: coverage is required`);
  if (segment.coverage.enabled) {
    assert(['source', 'dist', 'repository-scripts'].includes(segment.coverage.scope), `${subjectId}/${segment.id}: invalid coverage scope`);
    assert(Array.isArray(segment.coverage.include) && segment.coverage.include.length > 0, `${subjectId}/${segment.id}: coverage include is required`);
    assert(Array.isArray(segment.coverage.exclude), `${subjectId}/${segment.id}: coverage exclude is required`);
  } else if (typeof segment.coverage.reason !== 'string') {
    throw new Error(`${subjectId}/${segment.id}: disabled coverage requires reason`);
  }
};

export const validateDefinition = (definition, root = SCRIPT_ROOT) => {
  assert(isObject(definition), 'definition must be an object');
  assert(definition.schemaVersion === 1, 'schemaVersion must be 1');
  assert(definition.kind === 'contract-subject-execution', 'kind must be contract-subject-execution');
  assert(isObject(definition.report), 'report is required');
  assert(definition.report.unit === 'contract-subject-and-execution-segment', 'report.unit is invalid');
  assert.deepEqual(definition.report.metrics, ['C0', 'C1', 'line'], 'report.metrics must define C0, C1, line');
  assert(isRelativePath(definition.report.output), 'report.output must be project-relative');
  assert(Array.isArray(definition.subjects) && definition.subjects.length > 0, 'subjects are required');
  const ids = new Set();
  for (const subject of definition.subjects) {
    assert(isObject(subject), 'subject must be an object');
    assert(typeof subject.subjectId === 'string' && subject.subjectId.length > 0, 'subjectId is required');
    assert(!ids.has(subject.subjectId), `duplicate subjectId: ${subject.subjectId}`);
    ids.add(subject.subjectId);
    assert(Array.isArray(subject.segments) && subject.segments.length > 0, `${subject.subjectId}: segments are required`);
    const segmentIds = new Set();
    for (const segment of subject.segments) {
      assert(!segmentIds.has(segment.id), `${subject.subjectId}: duplicate segment ${segment.id}`);
      segmentIds.add(segment.id);
      validateSegment(segment, subject.subjectId, root);
    }
  }
  return definition;
};

export const loadDefinition = (definitionPath = DEFAULT_DEFINITION, root = SCRIPT_ROOT) => {
  const definition = JSON.parse(readFileSync(definitionPath, 'utf8'));
  return validateDefinition(definition, root);
};

const commandForSegment = (segment, reportPath) => {
  const args = [];
  if (segment.coverage?.enabled) {
    args.push('--experimental-test-coverage');
    for (const include of segment.coverage.include) args.push(`--test-coverage-include=${include}`);
    for (const exclude of segment.coverage.exclude) args.push(`--test-coverage-exclude=${exclude}`);
    args.push('--test-reporter=lcov', `--test-reporter-destination=${reportPath}`);
  }
  if (segment.typescript) args.push('--import=tsx');
  args.push('--test', ...segment.tests);
  return { command: process.execPath, args };
};

const run = (command, args, cwd) => spawnSync(command, args, { cwd, encoding: 'utf8' });

const executeSubject = (subject, root, reportRoot, dryRun) => {
  if (subject.build) {
    const buildCwd = path.join(root, subject.build.cwd);
    if (dryRun) console.log(JSON.stringify({ subjectId: subject.subjectId, build: { cwd: subject.build.cwd, command: subject.build.command } }));
    else {
      const [command, ...args] = subject.build.command;
      const result = run(command, args, buildCwd);
      if (result.status !== 0) throw new Error(`${subject.subjectId}: build failed\n${result.stderr}`);
    }
  }
  const segments = [];
  for (const segment of subject.segments) {
    if (segment.status === 'excluded') {
      segments.push({ id: segment.id, level: segment.level, status: 'excluded', reason: segment.reason });
      continue;
    }
    const cwd = path.join(root, segment.cwd);
    const reportPath = path.join(reportRoot, subject.subjectId.replaceAll('.', '_'), `${segment.id}.lcov`);
    if (segment.coverage?.enabled) mkdirSync(path.dirname(reportPath), { recursive: true });
    const { command, args } = commandForSegment(segment, reportPath);
    if (dryRun) {
      segments.push({ id: segment.id, level: segment.level, status: 'planned', cwd: segment.cwd, command: [command, ...args], coverageScope: segment.coverage?.scope ?? null });
      continue;
    }
    const result = run(command, args, cwd);
    if (result.status !== 0) throw new Error(`${subject.subjectId}/${segment.id}: tests failed\n${result.stderr || result.stdout}`);
    const resultRecord = {
      id: segment.id,
      level: segment.level,
      status: 'passed',
      cwd: segment.cwd,
      tests: segment.tests,
      coverageScope: segment.coverage?.scope ?? null,
      coverageResultIdentity: `${subject.subjectId}/${segment.id}`,
    };
    if (segment.coverage?.enabled) {
      const coverage = parseLcov(readFileSync(reportPath, 'utf8'));
      const files = coverage.files.map((file) => file.sourceFile);
      resultRecord.coverage = { metrics: coverage.metrics, files, sourceArtifactIdentity: files };
    } else {
      const reason = segment.coverage?.reason ?? 'coverage disabled by execution definition';
      resultRecord.coverage = { status: 'not-available', reason, metrics: unavailableCoverage(reason), files: [], sourceArtifactIdentity: null };
    }
    segments.push(resultRecord);
  }
  return { subjectId: subject.subjectId, segments };
};

// The aggregate threshold is acquired by running a subject's unit and integration segments
// together in a single process, so Node reports one LCOV branch set for that group with
// stable, comparable branch counters. This collector sums the per-file BRH/BRF and LH/LF
// counters (the same metric semantics as the segment report) across groups and fails closed
// when the same source artifact is observed by more than one group, because LCOV branch
// numbering is process-dependent and must not be merged across instrumentation contexts.
export const aggregateCoverageMaps = (coverageMaps, root) => {
  const byScope = new Map();
  const ownerByFile = new Map();
  for (const map of coverageMaps) {
    if (!map || !Array.isArray(map.files)) continue;
    const bucket = byScope.get(map.scope) ?? { levels: new Set(), files: new Map() };
    for (const level of map.levels ?? []) bucket.levels.add(level);
    for (const file of map.files) {
      const relative = path.relative(root, path.resolve(map.cwd, file.sourceFile));
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
      const owner = ownerByFile.get(relative);
      if (owner !== undefined && owner !== map.groupId) {
        throw new Error(`coverage aggregate cannot merge ${relative} across instrumentation groups (${owner} and ${map.groupId})`);
      }
      ownerByFile.set(relative, map.groupId);
      const target = bucket.files.get(relative) ?? { C1: { covered: 0, total: 0 }, line: { covered: 0, total: 0 } };
      target.C1.covered += file.branches.hit;
      target.C1.total += file.branches.total;
      target.line.covered += file.lines.hit;
      target.line.total += file.lines.total;
      bucket.files.set(relative, target);
    }
    byScope.set(map.scope, bucket);
  }
  const withPercentage = (value) => ({
    covered: value.covered,
    total: value.total,
    percentage: value.total === 0 ? null : Number(((value.covered / value.total) * 100).toFixed(2)),
  });
  const byScopeResult = {};
  for (const [scope, bucket] of byScope) {
    const files = [...bucket.files.entries()]
      .map(([filePath, records]) => ({
        path: filePath,
        C1: withPercentage(records.C1),
        line: withPercentage(records.line),
      }))
      .sort((left, right) => left.path.localeCompare(right.path));
    const sum = (key) => files.reduce(
      (total, file) => ({
        covered: total.covered + file[key].covered,
        total: total.total + file[key].total,
      }),
      { covered: 0, total: 0 },
    );
    byScopeResult[scope] = {
      scope,
      levels: [...bucket.levels].sort(),
      metrics: {
        C0: unavailableMetric('Node LCOV exposes function counts, not statement counts; line coverage is not substituted for C0.'),
        C1: withPercentage(sum('C1')),
        line: withPercentage(sum('line')),
      },
      files,
    };
  }
  return {
    metricSemantics: { C0: 'statement', C1: 'branch', line: 'line' },
    byScope: byScopeResult,
  };
};

export const collectAggregateCoverage = (subjects, root, reportRoot) => {
  const maps = [];
  for (const subject of subjects) {
    const byScope = new Map();
    for (const segment of subject.segments) {
      if (segment.status === 'excluded' || !segment.coverage?.enabled) continue;
      if (!['unit', 'integration'].includes(segment.level)) continue;
      const scope = segment.coverage.scope;
      const group = byScope.get(scope) ?? [];
      group.push(segment);
      byScope.set(scope, group);
    }
    for (const [scope, group] of byScope) {
      const cwd = path.join(root, group[0].cwd);
      const tests = [...new Set(group.flatMap((segment) => segment.tests))];
      const include = [...new Set(group.flatMap((segment) => segment.coverage.include))];
      const exclude = [...new Set(group.flatMap((segment) => segment.coverage.exclude))];
      const groupId = `${subject.subjectId}/${scope}`;
      const lcovPath = path.join(reportRoot, 'aggregate', subject.subjectId.replaceAll('.', '_'), `${scope}.lcov`);
      mkdirSync(path.dirname(lcovPath), { recursive: true });
      const args = ['--experimental-test-coverage'];
      for (const pattern of include) args.push(`--test-coverage-include=${pattern}`);
      for (const pattern of exclude) args.push(`--test-coverage-exclude=${pattern}`);
      args.push('--test-reporter=lcov', `--test-reporter-destination=${lcovPath}`);
      if (group.some((segment) => segment.typescript === true)) args.push('--import=tsx');
      args.push('--test', ...tests);
      const result = run(process.execPath, args, cwd);
      if (result.status !== 0) {
        throw new Error(`${groupId}: aggregate coverage run failed\n${result.stderr || result.stdout}`);
      }
      const coverage = parseLcov(readFileSync(lcovPath, 'utf8'));
      maps.push({ groupId, levels: group.map((segment) => segment.level), scope, cwd, files: coverage.files });
    }
  }
  return aggregateCoverageMaps(maps, root);
};

const parseArgs = (args) => {
  const options = { definition: DEFAULT_DEFINITION, subject: null, all: false, check: false, dryRun: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--definition') options.definition = path.resolve(args[++index]);
    else if (arg === '--subject') options.subject = args[++index];
    else if (arg === '--all') options.all = true;
    else if (arg === '--check') options.check = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  return options;
};

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  const definition = loadDefinition(options.definition);
  if (options.check) {
    console.log(`Execution definition is valid (${definition.subjects.length} contract subjects).`);
    return;
  }
  if (!options.subject && !options.all) throw new Error('select one subject with --subject or use --all');
  const subjects = options.subject ? definition.subjects.filter((subject) => subject.subjectId === options.subject) : definition.subjects;
  if (subjects.length === 0) throw new Error(`unknown contract subject: ${options.subject}`);
  const reportRoot = path.join(SCRIPT_ROOT, 'tests/tmp/coverage/contract-subject');
  const results = subjects.map((subject) => executeSubject(subject, SCRIPT_ROOT, reportRoot, options.dryRun));
  if (options.dryRun) return;
  const coverageAggregate = collectAggregateCoverage(subjects, SCRIPT_ROOT, reportRoot);
  const reportPath = path.join(SCRIPT_ROOT, definition.report.output);
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify({ schemaVersion: 1, definitionId: definition.id, reportUnit: definition.report.unit, metrics: definition.report.metrics, coverageAggregate, subjects: results }, null, 2)}\n`);
  console.log(`Contract-subject coverage report written to ${path.relative(SCRIPT_ROOT, reportPath)}.`);
};

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
