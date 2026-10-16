import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
// Synchronous child processes block the worker, so Vitest's testTimeout cannot interrupt them; bound each call.
// A timeout means the call regressed: investigate its performance or split it before raising the limit.
// Single selected test: measured 0.07s; the limit is the 5s floor that absorbs process start-up jitter.
const spawnTimeoutMs = 5000;
// Coverage run of every Python suite in one call: measured 18-36s; the limit is about 5x the typical 18s.
const suiteTimeoutMs = 90000;
// Each Python suite file runs in its own process, in parallel: measured max 7.7s alone; the limit leaves room for CPU contention.
const pythonSuiteTimeoutMs = 40000;
const execFileAsync = promisify(execFile);

describe('provider installer', () => {
  // evidence_role: supplemental
  // flow_id: provider-installer-runtime-regression
  // test_level: e2e
  describe('common regression', () => {
    test('executes provider assembly, builders and available native runtime safety regressions', async () => {
      // Arrange
      const directory = fileURLToPath(new URL('.', import.meta.url));
      const python = process.platform === 'win32' ? 'python' : 'python3';
      // Act
      const coverageOutput = process.env.A3_CI_INSTALLER_COVERAGE_OUTPUT;
      const suites = fs.readdirSync(directory).filter((name) => /^test_.*\.py$/.test(name)).sort();
      const results = coverageOutput === undefined
        ? await Promise.allSettled(suites.map((suite) => execFileAsync(python, ['-m', 'unittest', 'discover', '-s', directory, '-p', suite], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8', timeout: pythonSuiteTimeoutMs })))
        : [execFileSync(process.execPath, [fileURLToPath(new URL('../../../tests/coverage-tools/measure-installer-coverage.mjs', import.meta.url)), 'run', coverageOutput], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: suiteTimeoutMs })];
      // Assert
      expect(suites.length).toBeGreaterThan(0);
      const failures = results.filter((result) => result.status === 'rejected').map((result) => String(result.reason?.stderr ?? result.reason));
      expect(failures, failures.join('\n')).toEqual([]);
    }, 120000);
  });
});

describe('contract.ci-release-supplemental-asset.outputs', () => {
  // evidence_role: contract
  // flow_id: standard-installer-entry-names
  // test_level: e2e
  describe('standard entry names', () => {
    test('rejects nonstandard public names before generating output', () => {
      // Arrange
      const directory = fileURLToPath(new URL('.', import.meta.url));
      const python = process.platform === 'win32' ? 'python' : 'python3';
      // Act
      const result = execFileSync(python, ['-m', 'unittest', 'discover', '-s', directory, '-p', 'test_assembly.py', '-k', 'standard_entry_names_rejected'], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8', timeout: spawnTimeoutMs });
      // Assert
      expect(typeof result).toBe('string');
    });
  });
});
