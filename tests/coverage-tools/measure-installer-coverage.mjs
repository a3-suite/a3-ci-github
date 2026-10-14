import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const outputRoot = path.join(root, 'tests/tmp/coverage/installer');
const config = path.join(root, 'runtime/installer/tests/coverage.ini');

const outputPath = (value) => {
  assert(typeof value === 'string' && value.length > 0, 'installer coverage output is required');
  const output = path.resolve(root, value);
  const relative = path.relative(outputRoot, output);
  assert(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), 'installer coverage output must be under tests/tmp/coverage/installer');
  return output;
};

const executeCoverage = (output, commands, execute) => {
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', COVERAGE_RCFILE: config, COVERAGE_FILE: path.join(output, '.coverage') };
  for (const command of commands) {
    const result = execute('uv', ['run', '--no-project', '--with', 'coverage==7.16.2', 'coverage', ...command], { cwd: root, env, stdio: 'inherit' });
    if (result.error) throw result.error;
    assert(result.status === 0, 'installer coverage command failed: ' + command[0]);
  }
};

export const runInstallerCoverage = (value, execute = spawnSync) => {
  const output = outputPath(value);
  mkdirSync(path.dirname(output), { recursive: true });
  // A fresh acquisition prevents a previous failed or successful run from satisfying this run.
  mkdirSync(output);
  executeCoverage(output, [['run', '-m', 'unittest', 'discover', '-s', 'runtime/installer/tests', '-p', 'test_*.py']], execute);
  writeFileSync(path.join(output, 'regression-passed.json'), JSON.stringify({ output }), { flag: 'wx' });
};

export const reportInstallerCoverage = (value, execute = spawnSync) => {
  const output = outputPath(value);
  assert.deepEqual(JSON.parse(readFileSync(path.join(output, 'regression-passed.json'), 'utf8')), { output }, 'installer regression did not complete for this acquisition');
  executeCoverage(output, [['combine', output], ['json', '-o', path.join(output, 'coverage.json')], ['report']], execute);
  console.log('Python source coverage: ' + path.join(output, 'coverage.json'));
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, value, ...extra] = process.argv.slice(2);
  assert(extra.length === 0 && (mode === undefined || ((mode === 'run' || mode === 'report') && value)), 'expected run/report and one output directory, or no arguments');
  if (mode === 'run') runInstallerCoverage(value);
  else if (mode === 'report') reportInstallerCoverage(value);
  else {
    mkdirSync(outputRoot, { recursive: true });
    const output = path.join(mkdtempSync(path.join(outputRoot, 'run-')), 'source');
    runInstallerCoverage(output);
    reportInstallerCoverage(output);
  }
}
