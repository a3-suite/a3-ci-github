import assert from 'node:assert/strict';
import { globSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createInstrumenter } from 'istanbul-lib-instrument';
const require = createRequire(import.meta.url);
const { createCoverageMap } = require('istanbul-lib-coverage');
const { createContext } = require('istanbul-lib-report');
const reports = require('istanbul-reports');
const baseConfig = (await import('../../vitest.config.mjs')).default;
const config = process.argv[2] ? JSON.parse(process.argv[2]) : {
  root: baseConfig.root, cwd: baseConfig.root, typescript: true,
  tests: globSync(baseConfig.test.include, { cwd: baseConfig.root }),
  include: baseConfig.test.coverage.include, exclude: baseConfig.test.coverage.exclude,
  lcovPath: path.join(baseConfig.root, 'tests/tmp/coverage/vitest/lcov.info'),
};
const includes = config.include.map((pattern) => path.resolve(config.cwd, pattern));
const excludes = [...config.exclude.map((pattern) => path.resolve(config.cwd, pattern)), '**/node_modules/**'];
const files = [...new Set(globSync(includes, { exclude: excludes }).map((filename) => realpathSync(filename)))].filter((filename) => {
  const relative = path.relative(config.root, filename);
  assert(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), `coverage source escapes root: ${filename}`);
  return /\.(?:[cm]?[jt]s)$/.test(filename) && !/\.d\.[cm]?ts$/.test(filename);
});
assert(files.length, 'coverage include resolves to no source files');
const directory = path.dirname(config.lcovPath);
mkdirSync(directory, { recursive: true });
const runDirectory = mkdtempSync(path.join(directory, 'acquisition-'));
const rawDirectory = path.join(runDirectory, 'raw'); mkdirSync(rawDirectory);
const instrumenter = createInstrumenter({ esModules: true, parserPlugins: ['typescript'], compact: false, produceSourceMap: true });
const scripts = {};
const zero = {};
for (const filename of files) {
  const code = instrumenter.instrumentSync(readFileSync(filename, 'utf8'), filename);
  scripts[filename] = `${code}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(instrumenter.lastSourceMap())).toString('base64')}\n`;
  zero[filename] = JSON.parse(JSON.stringify(instrumenter.lastFileCoverage()));
}
const captureConfig = path.join(runDirectory, 'capture.json');
writeFileSync(captureConfig, JSON.stringify({ scripts, rawDirectory, typescript: config.typescript }));
const capture = fileURLToPath(new URL('./capture-coverage.mjs', import.meta.url));
const env = { ...process.env, A3_CI_COVERAGE_CONFIG: captureConfig,
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(capture)}`.trim() };
delete env.NODE_V8_COVERAGE;
const vitestConfigPath = path.join(runDirectory, 'vitest.config.mjs');
const setupPath = path.join(runDirectory, 'setup.mjs');
writeFileSync(setupPath, `import fs from 'node:fs';\nimport { randomUUID } from 'node:crypto';\nimport { afterAll } from 'vitest';\nglobalThis.__coverage__ = {};\nafterAll(() => {\n  const destination = ${JSON.stringify(rawDirectory)} + '/' + randomUUID() + '.json';\n  fs.writeFileSync(destination + '.pending', JSON.stringify({ coverage: globalThis.__coverage__, errors: [] }));\n  fs.renameSync(destination + '.pending', destination);\n  globalThis.__coverage__ = {};\n});\n`);
const settings = { root: config.root, test: { globals: false, pool: 'forks', maxWorkers: 1, setupFiles: [setupPath],
  testTimeout: 60000, reporters: ['default', 'json'], outputFile: path.join(runDirectory, 'test-results.json'), include: config.tests.map((file) => path.resolve(config.cwd, file)),
  coverage: { enabled: false } } };
// Vitest and native subprocesses execute the same pre-instrumented source counters.
writeFileSync(vitestConfigPath, `import fs from 'node:fs';\nconst { scripts } = JSON.parse(fs.readFileSync(${JSON.stringify(captureConfig)}, 'utf8'));\nexport default { ...${JSON.stringify(settings)}, plugins: [{ name: 'source-counters', enforce: 'pre', load(id) { const code = scripts[id.split('?')[0]]; return code?.startsWith('#!') ? code.slice(code.indexOf(String.fromCharCode(10))) : code ?? null; } }] };\n`);
const cli = fileURLToPath(new URL('../../node_modules/vitest/vitest.mjs', import.meta.url));
delete env.VITEST; delete env.VITEST_WORKER_ID; delete env.VITEST_POOL_ID;
const execution = spawnSync(process.execPath, [...(config.typescript ? ['--import', fileURLToPath(new URL('./node_modules/tsx/dist/loader.mjs', import.meta.url))] : []), cli, 'run', '--config', vitestConfigPath], { cwd: config.cwd, env, stdio: 'inherit' });
if (execution.status !== 0) process.exit(execution.status ?? 1);
const map = createCoverageMap(structuredClone(zero));
const graph = (counters) => ({ statementMap: counters.statementMap, fnMap: counters.fnMap, branchMap: counters.branchMap });
const rawFiles = readdirSync(rawDirectory);
assert(rawFiles.length, 'coverage acquisition did not produce a result');
assert(rawFiles.every((filename) => filename.endsWith('.json')), 'coverage acquisition contains an incomplete snapshot');
for (const filename of rawFiles) {
  const raw = JSON.parse(readFileSync(path.join(rawDirectory, filename), 'utf8'));
  assert.deepEqual(raw.errors, [], 'coverage load transformation failed');
  for (const [source, counters] of Object.entries(raw.coverage)) {
    assert(Object.hasOwn(zero, source), `coverage includes a source outside the inventory: ${source}`);
    assert.deepEqual(graph(counters), graph(zero[source]), `coverage counter inventory changed: ${source}`);
  }
  map.merge(raw.coverage);
}
assert(files.every((file) => map.files().includes(file)), 'coverage source inventory is incomplete');
for (const source of files) assert.deepEqual(graph(map.fileCoverageFor(source)), graph(zero[source]), `coverage merge changed the counter inventory: ${source}`);
const context = createContext({ dir: runDirectory, coverageMap: map });
reports.create('lcovonly').execute(context);
reports.create('json').execute(context);
writeFileSync(config.lcovPath, readFileSync(path.join(runDirectory, 'lcov.info')));
writeFileSync(`${config.lcovPath}.json`, JSON.stringify(map.toJSON(), null, 2) + '\n');
console.log(JSON.stringify({ sourceFiles: files.length, rawDirectory, nodeVersion: process.version }));
