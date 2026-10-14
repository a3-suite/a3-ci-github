import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { runInstallerCoverage, reportInstallerCoverage } from './coverage-tools/measure-installer-coverage.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

describe('installer coverage lifecycle', () => {
  // evidence_role: supplemental
  // integration_id: installer-coverage-lifecycle
  // test_level: integration
  test('reports only a fresh successful regression run and never reruns the suite', (t) => {
    // Arrange
    const parent = path.join(root, 'tests/tmp/coverage/installer');
    fs.mkdirSync(parent, { recursive: true });
    const directory = fs.mkdtempSync(path.join(parent, 'lifecycle-'));
    t.onTestFinished(() => fs.rmSync(directory, { recursive: true }));
    const failed = path.join(directory, 'failed');
    const passed = path.join(directory, 'passed');
    const calls = [];
    const execute = (command, args) => { calls.push({ command, args }); return { status: 0 }; };
    // Act / Assert
    expect(() => reportInstallerCoverage(passed, execute)).toThrow();
    expect(calls).toHaveLength(0);
    expect(() => runInstallerCoverage(failed, () => ({ status: 1 }))).toThrow();
    expect(() => reportInstallerCoverage(failed, execute)).toThrow();
    runInstallerCoverage(passed, execute);
    expect(() => runInstallerCoverage(passed, execute)).toThrow();
    reportInstallerCoverage(passed, execute);
    expect(calls.map((call) => call.args[5])).toStrictEqual(['run', 'combine', 'json', 'report']);
    expect(() => reportInstallerCoverage(passed, () => ({ status: null, signal: 'SIGTERM' }))).toThrow();
  });
});
