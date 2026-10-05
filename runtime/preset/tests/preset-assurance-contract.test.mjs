import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, describe, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { snapshotTree } from './support/release-request-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const bootstrapPath = 'runtime/preset/run-validate-ci-preset.mjs';
const run = (args) => spawnSync(process.execPath, [bootstrapPath, ...args], { cwd: root, encoding: 'utf8' });
const diagnosticOf = (result) => {
  expect(result.status).toBe(2);
  const diagnostic = JSON.parse(result.stderr.trim());
  expect(Object.keys(diagnostic).sort()).toStrictEqual(['schemaVersion', 'kind', 'outcome', 'reason', 'message'].sort());
  expect(diagnostic.kind).toBe('ci-github-preflight-bootstrap');
  return diagnostic;
};

describe("preset-assurance-contract", () => {
  describe("failure-diagnostics-contract", () => {
    // integration_id: preset-assurance-contract
    // integration_id: failure-diagnostics-contract
    test('preset assurance rejects a request without explicit roots', () => {
      // Arrange
      const cases = [
        [['--audit-mode', 'read-only'], /--repo-root is required/],
        [[], /--audit-mode must be/],
        [['--audit-mode', 'unknown', '--repo-root', '.'], /--audit-mode must be/],
        [['--audit-mode'], /missing value/],
        [['--audit-mode', '--repo-root', '.'], /missing value/],
        [['--unknown', 'value'], /unknown argument/],
      ];
      for (const [args, message] of cases) {
        // Act
        const diagnostic = diagnosticOf(run(args));
        // Assert
        expect(diagnostic.outcome).toBe('cannot-start');
        expect(diagnostic.reason).toBe('invalid-input');
        expect(diagnostic.message).toMatch(message);
      }
    });
  });
});

describe("preset-assurance-contract", () => {
  describe("preset-assurance-contract", () => {
    // integration_id: preset-assurance-contract
    test('preset assurance rejects remediation output in read-only mode', () => {
      const diagnostic = diagnosticOf(run([
        '--audit-mode', 'read-only',
        '--repo-root', '.',
        '--skill-collection-root', '.',
        '--output', 'report.json',
      ]));
      expect(diagnostic.outcome).toBe('cannot-start');
      expect(diagnostic.reason).toBe('invalid-input');
      expect(diagnostic.message).toMatch(/--output is not allowed in read-only mode/);
    });

    // integration_id: preset-assurance-contract
    test('preset assurance keeps validation of an explicitly supplied external skill root', () => {
      const diagnostic = diagnosticOf(run([
        '--audit-mode', 'read-only',
        '--repo-root', '.',
        '--skill-collection-root', 'VERSION',
      ]));
      expect(diagnostic.reason).toBe('runtime-unavailable');
    });
  });
});

describe("contract.ci-failure-diagnostics.actionable", () => {
  describe("failure-diagnostics-contract", () => {
    // evidence_role: contract
    // test_level: integration
    // integration_id: failure-diagnostics-contract
    // contract_id: contract.ci-failure-diagnostics.actionable
    test('preset assurance rejects unavailable or inconsistent prepared runtime without changing the project', () => {
      // Arrange
      fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
      const fixture = fs.mkdtempSync(path.join(root, 'tmp/preset-bootstrap-contract-'));
      const runtime = path.join(fixture, '.a3-skills/ci-github/runtime');
      const args = ['--audit-mode', 'read-only', '--repo-root', fixture];
      const reject = (reason) => {
        const before = snapshotTree(fixture);
        // Act
        const result = run(args);
        // Assert
        expect(diagnosticOf(result).reason).toBe(reason);
        expect(result.stdout).toBe('');
        expect(snapshotTree(fixture)).toStrictEqual(before);
      };
      try {
        reject('runtime-unavailable');
        fs.mkdirSync(path.dirname(runtime), { recursive: true });
        reject('runtime-unavailable');
        fs.mkdirSync(runtime);
        reject('runtime-lock-mismatch');
        for (const filename of ['package.json', 'package-lock.json']) {
          fs.copyFileSync(path.join(root, 'runtime/preset', filename), path.join(runtime, filename));
        }
        reject('runtime-dependency-tree-invalid');
        fs.mkdirSync(path.join(runtime, 'node_modules'));
        reject('runtime-dependency-tree-invalid');
        for (const filename of ['package.json', 'package-lock.json']) {
          const target = path.join(runtime, filename);
          const original = fs.readFileSync(target);
          fs.writeFileSync(target, '{}');
          reject('runtime-lock-mismatch');
          fs.writeFileSync(target, original);
        }
      } finally {
        fs.rmSync(fixture, { recursive: true, force: true });
      }
    });
  });
});

// Executable-bit and signal collaborators require POSIX; Windows needs separate runtime evidence.
const withPreparedBootstrap = (callback) => {
  const fixture = fs.mkdtempSync(path.join(root, 'tmp/bootstrap-process-'));
  const consumer = path.join(fixture, 'consumer');
  const runtime = path.join(consumer, '.a3-skills/ci-github/runtime');
  const modules = path.join(runtime, 'node_modules');
  const bin = path.join(fixture, 'bin');
  const settingsPath = path.join(fixture, 'settings.json');
  const tracePath = path.join(fixture, 'trace.jsonl');
  fs.mkdirSync(path.join(modules, '.bin'), { recursive: true });
  fs.mkdirSync(path.join(modules, 'tsx'));
  fs.mkdirSync(path.join(modules, 'yaml'));
  fs.mkdirSync(bin);
  for (const filename of ['package.json', 'package-lock.json']) {
    fs.copyFileSync(path.join(root, 'runtime/preset', filename), path.join(runtime, filename));
  }
  const command = (name) => `#!${process.execPath}\nimport fs from 'node:fs';\nconst settings = JSON.parse(fs.readFileSync(process.env.BOOTSTRAP_TEST_SETTINGS, 'utf8'))[${JSON.stringify(name)}] ?? {};\nfs.appendFileSync(process.env.BOOTSTRAP_TEST_TRACE, JSON.stringify({ command: ${JSON.stringify(name)}, args: process.argv.slice(2), temp: process.env.TMPDIR, cache: process.env.npm_config_cache, runtime: process.env.CI_GITHUB_PREFLIGHT_RUNTIME_ROOT }) + '\\n');\nif (settings.denyExecutable) fs.chmodSync(settings.denyExecutable, 0o644);\nif (settings.signal) process.kill(process.pid, settings.signal);\nif (settings.stdout) process.stdout.write(settings.stdout);\nif (settings.stderr) process.stderr.write(settings.stderr);\nprocess.exitCode = settings.status ?? 0;\n`;
  const validator = path.join(modules, 'tsx/cli.mjs');
  fs.writeFileSync(validator, command('validator'), { mode: 0o755 });
  fs.symlinkSync('../tsx/cli.mjs', path.join(modules, '.bin/tsx'));
  fs.writeFileSync(path.join(modules, 'yaml/package.json'), '{}');
  fs.writeFileSync(path.join(bin, 'npm'), command('npm'), { mode: 0o755 });
  const execute = ({ npm = {}, validator: validatorSettings = {}, args = [], env = {} } = {}) => {
    fs.writeFileSync(settingsPath, JSON.stringify({ npm, validator: validatorSettings }));
    fs.rmSync(tracePath, { force: true });
    const result = spawnSync(process.execPath, [bootstrapPath, '--audit-mode', 'read-only', '--repo-root', consumer, ...args], {
      cwd: root, encoding: 'utf8', env: { ...process.env, PATH: bin, BOOTSTRAP_TEST_SETTINGS: settingsPath,
        BOOTSTRAP_TEST_TRACE: tracePath, ...env },
    });
    const trace = fs.existsSync(tracePath)
      ? fs.readFileSync(tracePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
    return { result, trace };
  };
  try {
    return callback({ fixture, consumer, runtime, modules, validator, bin, execute });
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
};

describe("contract.ci-failure-diagnostics.actionable", () => {
  describe("failure-diagnostics-contract", () => {
    // evidence_role: contract
    // test_level: integration
    // integration_id: failure-diagnostics-contract
    // contract_id: contract.ci-failure-diagnostics.actionable
    test.runIf(process.platform !== 'win32')('preset bootstrap confines dependency files and accepts internal symlink cycles', () => {
      // Arrange
      withPreparedBootstrap((fixture) => {
        const { consumer, runtime, modules, execute } = fixture;
        const cases = [
          ['canonical file symlink', () => {
            const file = path.join(runtime, 'package.json');
            fs.unlinkSync(file);
            fs.symlinkSync(path.join(root, 'runtime/preset/package.json'), file);
            return () => { fs.unlinkSync(file); fs.copyFileSync(path.join(root, 'runtime/preset/package.json'), file); };
          }, 'runtime-lock-mismatch'],
          ['escaping dependency link', () => {
            const link = path.join(modules, 'outside');
            fs.symlinkSync(fixture.bin, link);
            return () => fs.unlinkSync(link);
          }, 'runtime-outside-tool-state'],
          ['nested escaping dependency link', () => {
            const directory = path.join(modules, 'nested-escape');
            fs.mkdirSync(directory);
            const link = path.join(directory, 'outside');
            fs.symlinkSync(fixture.bin, link);
            return () => { fs.unlinkSync(link); fs.rmdirSync(directory); };
          }, 'runtime-outside-tool-state'],
          ['internal directory link containing an escape', () => {
            const directory = path.join(modules, 'scan-target');
            const entry = path.join(modules, 'a-scan-link');
            fs.mkdirSync(directory);
            const outside = path.join(directory, 'outside');
            fs.symlinkSync(fixture.bin, outside);
            fs.symlinkSync(directory, entry);
            return () => { fs.unlinkSync(entry); fs.unlinkSync(outside); fs.rmdirSync(directory); };
          }, 'runtime-outside-tool-state'],
          ['escaping tsx executable', () => {
            const link = path.join(modules, '.bin/tsx');
            fs.unlinkSync(link);
            fs.symlinkSync(path.join(fixture.bin, 'npm'), link);
            return () => { fs.unlinkSync(link); fs.symlinkSync('../tsx/cli.mjs', link); };
          }, 'runtime-outside-tool-state'],
          ['escaping yaml directory', () => {
            const directory = path.join(modules, 'yaml');
            fs.renameSync(directory, `${directory}-saved`);
            fs.symlinkSync(fixture.bin, directory);
            return () => { fs.unlinkSync(directory); fs.renameSync(`${directory}-saved`, directory); };
          }, 'runtime-outside-tool-state'],
        ];
        for (const [label, mutate, reason] of cases) {
          const restore = mutate();
          try {
            const before = snapshotTree(consumer);
            // Act
            const { result, trace } = execute();
            // Assert
            expect(diagnosticOf(result).reason, label).toBe(reason);
            expect(result.stdout, label).toBe('');
            expect(trace, label).toStrictEqual([]);
            expect(snapshotTree(consumer), label).toStrictEqual(before);
          } finally {
            restore();
          }
        }
        // Arrange
        fs.symlinkSync(modules, path.join(modules, 'cycle'));
        fs.mkdirSync(path.join(modules, 'nested'));
        fs.symlinkSync(path.join(modules, 'yaml'), path.join(modules, 'nested/internal-yaml'));
        fs.symlinkSync(path.join(modules, 'yaml/package.json'), path.join(modules, 'nested/internal-file'));
        const before = snapshotTree(consumer);
        // Act
        const { result, trace } = execute({ validator: { stdout: 'callee result' } });
        // Assert
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe('callee result');
        expect(trace.map((entry) => entry.command)).toStrictEqual(['npm', 'validator']);
        expect(snapshotTree(consumer)).toStrictEqual(before);
        expect(trace.every((entry) => !fs.existsSync(entry.temp))).toBeTruthy();
      });
    });

    // evidence_role: contract
    // test_level: integration
    // integration_id: failure-diagnostics-contract
    // contract_id: contract.ci-failure-diagnostics.actionable
    test.runIf(process.platform !== 'win32')('preset bootstrap reports unavailable npm and cleans up state after dependency command failures', () => {
      // Arrange
      withPreparedBootstrap(({ fixture, consumer, execute }) => {
        const emptyBin = path.join(fixture, 'empty-bin');
        fs.mkdirSync(emptyBin);
        const cases = [
          [{ env: { PATH: emptyBin } }, /ENOENT/],
          [{ npm: { status: 1, stderr: 'dependency tree rejected' } }, /dependency tree rejected/],
          [{ npm: { status: 1 } }, /npm dependency tree validation failed/],
        ];
        for (const [settings, message] of cases) {
          const before = snapshotTree(consumer);
          // Act
          const { result, trace } = execute(settings);
          // Assert
          const diagnostic = diagnosticOf(result);
          expect(diagnostic.reason).toBe('runtime-dependency-tree-invalid');
          expect(diagnostic.outcome).toBe('cannot-start');
          expect(diagnostic.message).toMatch(message);
          expect(result.stdout).toBe('');
          expect(trace.length).toBe(settings.npm ? 1 : 0);
          expect(trace.every((entry) => entry.command === 'npm')).toBeTruthy();
          expect(trace.every((entry) => !fs.existsSync(entry.temp))).toBeTruthy();
          expect(snapshotTree(consumer)).toStrictEqual(before);
        }
      });
    });

    // evidence_role: contract
    // test_level: integration
    // integration_id: failure-diagnostics-contract
    // contract_id: contract.ci-failure-diagnostics.actionable
    test.runIf(process.platform !== 'win32')('preset bootstrap reports validator startup and completion failures without consumer changes', () => {
      // Arrange
      withPreparedBootstrap(({ consumer, validator, execute }) => {
        const cases = [
          [{ npm: { denyExecutable: validator } }, 'validator-cannot-start', 'cannot-start', /EACCES/],
          [{ validator: { signal: 'SIGTERM' } }, 'validator-cannot-start', 'cannot-start', /without an exit status/],
          [{ validator: { status: 2, stderr: 'callee cannot complete' } }, 'validator-cannot-complete', 'cannot-complete', /callee cannot complete/],
          [{ validator: { status: 2 } }, 'validator-cannot-complete', 'cannot-complete', /without a report/],
        ];
        for (const [settings, reason, outcome, message] of cases) {
          fs.chmodSync(validator, 0o755);
          const before = snapshotTree(consumer);
          // Act
          const { result, trace } = execute(settings);
          // Assert
          const diagnostic = diagnosticOf(result);
          expect(diagnostic.reason).toBe(reason);
          expect(diagnostic.outcome).toBe(outcome);
          expect(diagnostic.message).toMatch(message);
          expect(result.stdout).toBe('');
          expect(trace[0].command).toBe('npm');
          expect(trace.every((entry) => !fs.existsSync(entry.temp))).toBeTruthy();
          expect(snapshotTree(consumer)).toStrictEqual(before);
        }
      });
    });
  });
});

describe("preset-assurance-contract", () => {
  describe("preset-bootstrap-delegation", () => {
    // evidence_role: supplemental
    // test_level: integration
    // integration_id: preset-bootstrap-delegation
    test.runIf(process.platform !== 'win32')('preset bootstrap forwards explicit remediation inputs and preserves child results', () => {
      // Arrange
      withPreparedBootstrap(({ fixture, consumer, runtime, execute }) => {
        const externalSkills = path.join(fixture, 'external-skills');
        fs.mkdirSync(externalSkills);
        const output = path.join(fixture, 'report.json');
        const before = snapshotTree(consumer);
        const stdout = '{"status":"failed"}\n';
        // Act
        const { result, trace } = execute({ args: ['--audit-mode', 'remediation', '--skill-collection-root', externalSkills,
          '--preset', 'release-request', '--preset', 'quality-gate', '--output', output],
          validator: { status: 1, stdout, stderr: 'callee diagnostic\n' } });
        // Assert
        expect(result.status, result.stderr).toBe(1);
        expect(result.stdout).toBe(stdout);
        expect(result.stderr).toBe('callee diagnostic\n');
        expect(trace[0].args).toStrictEqual(['ls', '--prefix', runtime, '--all', '--json', '--no-audit', '--no-fund']);
        expect(trace[1].args).toStrictEqual([path.join(root, 'runtime/preset/validate-ci-preset.ts'), '--repo-root', consumer,
          '--skill-collection-root', externalSkills, '--preset', 'release-request', '--preset', 'quality-gate', '--output', output]);
        expect(trace[1].runtime).toBe(runtime);
        expect(path.dirname(trace[0].cache)).toBe(trace[0].temp);
        expect(trace.every((entry) => !fs.existsSync(entry.temp))).toBeTruthy();
        expect(snapshotTree(consumer)).toStrictEqual(before);
      });
    });
  });
});
