import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test, describe, expect } from 'vitest';
import * as sourceVerification from '../runtime/repository/verify-action-packages.mjs';
import { collectActionPackages, verificationPlan } from '../runtime/repository/verify-action-packages.mjs';
import { root } from "./action-package-verification.fixtures.mjs";

describe('repository-cli-source-verification', () => {
  describe('cliTypecheckPlan', () => {
    // contract_id: contract.repository-action-distribution.source-verification
    // test_level: e2e
    // flow_id: repository-cli-source-verification
    test('the CLI verification plan accepts valid sources and rejects type errors in every CLI source family', (t) => {
      // Arrange
      const parent = path.join(root, 'tests/tmp');
      fs.mkdirSync(parent, { recursive: true });
      const fixtureRoot = fs.mkdtempSync(path.join(parent, 'cli-typecheck-'));
      t.onTestFinished(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
      for (const config of ['tsconfig.action.json', 'tsconfig.cli.json']) {
        fs.copyFileSync(path.join(root, config), path.join(fixtureRoot, config));
      }
      const sources = ['runtime/adapter/cli-runtime.ts', 'runtime/preset/validate-ci-preset.ts', 'runtime/distribution/generate-distribution-release.ts', 'runtime/installer/cli.ts'];
      for (const source of sources) {
        const filename = path.join(fixtureRoot, source);
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, 'export const value: string = "valid";\n');
      }
      const excluded = path.join(fixtureRoot, 'runtime/preset/tests/excluded.test.ts');
      fs.mkdirSync(path.dirname(excluded), { recursive: true });
      fs.writeFileSync(excluded, 'export const value: string = 7;\n');
      const step = sourceVerification.cliTypecheckPlan(fixtureRoot, collectActionPackages(root))[0];
      // Act
      const valid = spawnSync(step.command, step.args, { cwd: step.cwd, encoding: 'utf8' });
      for (const source of sources) fs.writeFileSync(path.join(fixtureRoot, source), 'export const value = (input) => input;\n');
      const invalid = spawnSync(step.command, step.args, { cwd: step.cwd, encoding: 'utf8' });
      // Assert
      expect(valid.status, valid.stdout + valid.stderr).toBe(0);
      expect(invalid.status).not.toBe(0);
      for (const source of sources) expect(invalid.stdout.replaceAll('\\', '/')).toContain(source);
      expect(invalid.stdout).toContain('TS7006');
      expect(step.args.some((argument) => argument === 'ci' || argument === 'build')).toBe(false);
    });
  });
});


describe("contract.repository-action-distribution.source-verification", () => {
  describe("repository-action-source-verification", () => {

    const runSourceVerificationCli = (t, mode) => {
      // Arrange
      const parent = path.join(root, 'tests/tmp');
      fs.mkdirSync(parent, { recursive: true });
      const fixture = fs.mkdtempSync(path.join(parent, 'source-verification-cli-'));
      t.onTestFinished(() => fs.rmSync(fixture, { recursive: true, force: true }));
      const write = (relative, content, mode) => {
        fs.mkdirSync(path.dirname(path.join(fixture, relative)), { recursive: true });
        fs.writeFileSync(path.join(fixture, relative), content, mode ? { mode } : undefined);
      };
      for (const relative of ['runtime/repository/verify-action-packages.mjs', 'runtime/repository/check-action-dist.mjs', 'runtime/repository/check-runtime-boundaries.mjs',
        'runtime/diagnostics/failure.mjs', 'runtime/vitest/vitest-report-core.mjs']) write(relative, fs.readFileSync(path.join(root, relative)));
      write('actions/alpha/action.yml', 'name: alpha\nruns:\n  using: node24\n  main: dist/index.js\n');
      for (const [relative, content] of [['README.md', '# alpha\n'], ['package.json', JSON.stringify({ scripts: { lint: mode === 'metadata-invalid' ? 'eslint .' : 'tsc --noEmit' } })], ['package-lock.json', '{}\n'],
        ['tsconfig.json', '{}\n'], ['src/index.ts', 'export {};\n'], ['dist/index.js', '\n'], ['tests/a.test.ts', '\n']]) write(`actions/alpha/${relative}`, content);
      fs.symlinkSync(path.join(collectActionPackages(root)[0].path, 'node_modules'), path.join(fixture, 'actions/alpha/node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
      for (const name of ['ci-gh-provisioner', 'ci-release-assembly']) {
        write(`actions/${name}/action.yml`, `name: ${name}\nruns:\n  using: composite\n  steps: []\n`);
        write(`actions/${name}/README.md`, `# ${name}\n`);
      }
      const sharedTests = ['tests/boundary.process.test.mjs', 'runtime/provisioner/tests/provision-core.test.ts', 'runtime/installer/tests/common-regression.test.mjs',
        ...['assembly.test.mjs', 'observation.test.mjs', 'observation-policy.test.mjs', 'schema.test.ts', 'publisher.test.mjs', 'notes-binding.test.ts', 'skill-zip.test.ts'].map((name) => `runtime/release-publication/tests/${name}`)];
      for (const relative of sharedTests) write(relative, '\n');
      write('runtime/release-publication/tests/assembly.process.test.mjs', '\n');
      write('cli.ts', 'export const value: string = "valid";\n');
      write('tsconfig.cli.json', JSON.stringify({ compilerOptions: { noEmit: true, strict: true }, files: ['cli.ts'] }));
      const log = path.join(fixture, 'invocations.log');
      // The stub records each runner invocation and reports every requested file as passed, so the CLI's own report check applies.
      write('node_modules/vitest/vitest.mjs', `import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ runner: 'vitest', args }) + '\\n');
if (${mode === 'test-failure'}) process.exit(1);
const output = args.find((value) => value.startsWith('--outputFile='));
const files = args.slice(3).filter((value) => !value.startsWith('--'));
if (output) fs.writeFileSync(output.slice('--outputFile='.length), JSON.stringify({ success: true, testResults: files.map((name) => ({ name, status: 'passed', assertionResults: [{ fullName: 'stub > passes', status: 'passed' }] })) }));
`);
      write('bin/npm', `#!/bin/sh\nprintf '{"runner":"npm","cwd":"%s","args":"%s"}\\n' "$PWD" "$*" >> ${JSON.stringify(log)}\nexit ${mode === 'typecheck-failure' ? 7 : 0}\n`, 0o755);
      // Act
      const result = spawnSync(process.execPath, [path.join(fixture, 'runtime/repository/verify-action-packages.mjs')], { cwd: fixture, encoding: 'utf8',
        env: { ...process.env, PATH: `${path.join(fixture, 'bin')}${path.delimiter}${process.env.PATH}` }, timeout: 30_000 });
      // Assert
      expect(result.error, 'the source verification CLI did not finish normally').toBeUndefined();
      const invocations = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
      const actionLint = { runner: 'npm', cwd: fs.realpathSync(path.join(fixture, 'actions/alpha')), args: 'run lint' };
      if (mode === 'typecheck-failure') {
        expect(result.status).toBe(1);
        const diagnostic = result.stderr.match(/^ci-failure-diagnostic:(.+)$/m);
        expect(diagnostic).not.toBeNull();
        expect(JSON.parse(diagnostic[1]).classification).toMatchObject({ stage: 'typecheck', reason: 'action-source-verification-failed' });
        expect(invocations).toStrictEqual([actionLint]);
        return;
      }
      if (mode === 'test-failure' || mode === 'metadata-invalid') {
        expect(result.status).toBe(1);
        const diagnostic = result.stderr.match(/^ci-failure-diagnostic:(.+)$/m);
        expect(diagnostic, result.stderr).not.toBeNull();
        expect(JSON.parse(diagnostic[1]).classification).toMatchObject(mode === 'test-failure'
          ? { stage: 'test', reason: 'action-source-verification-failed' }
          : { stage: 'action-inventory' });
        expect(invocations.map(({ runner }) => runner)).toStrictEqual(mode === 'test-failure' ? ['npm', 'vitest'] : []);
        return;
      }
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain('Action source verification passed (1 bundled Actions).');
      expect(invocations.filter((entry) => entry.runner === 'npm')).toStrictEqual([actionLint]);
      const runs = invocations.filter((entry) => entry.runner === 'vitest');
      expect(runs).toHaveLength(1);
      const tested = runs[0].args.slice(3).filter((value) => !value.startsWith('--')).map((file) => path.relative(fixture, file).split(path.sep).join('/'));
      expect(tested.sort()).toStrictEqual(['actions/alpha/tests/a.test.ts', ...sharedTests].sort());
      if (mode === 'commands') expect(invocations.some((entry) => [].concat(entry.args).join(' ').split(' ').some((value) => ['ci', 'install', 'build'].includes(value)))).toBe(false);
    };

    // contract_id: contract.repository-action-distribution.source-verification
    // flow_id: repository-action-source-verification
    test('source verification CLI typechecks and tests every bundled Action and shared runtime test', (t) => runSourceVerificationCli(t, 'coverage'));

    // contract_id: contract.repository-action-distribution.source-verification
    // flow_id: repository-action-source-verification
    test('source verification CLI reports the failed typecheck stage', (t) => runSourceVerificationCli(t, 'typecheck-failure'));

    // contract_id: contract.repository-action-distribution.source-verification
    // flow_id: repository-action-source-verification
    test('source verification CLI reports the failed test stage', (t) => runSourceVerificationCli(t, 'test-failure'));

    // contract_id: contract.repository-action-distribution.source-verification
    // flow_id: repository-action-source-verification
    test('source verification CLI reports the inventory stage for invalid Action metadata', (t) => runSourceVerificationCli(t, 'metadata-invalid'));

    // evidence_role: supplemental
    // Running neither install nor build is an implementation detail that no contract guarantee covers.
    // flow_id: repository-action-source-verification
    test('source verification CLI runs neither install nor build', (t) => runSourceVerificationCli(t, 'commands'));

    // contract_id: contract.repository-action-distribution.source-verification
    // flow_id: repository-action-source-verification
    test('batched typechecks keep project globals isolated and reject errors after a previous successful build', (t) => {
      // Arrange
      const parent = path.join(root, 'tests/tmp');
      fs.mkdirSync(parent, { recursive: true });
      const fixture = fs.mkdtempSync(path.join(parent, 'batched-typecheck-'));
      t.onTestFinished(() => fs.rmSync(fixture, { recursive: true }));
      fs.copyFileSync(path.join(root, 'tsconfig.action.json'), path.join(fixture, 'tsconfig.action.json'));
      const dependencyRoot = path.join(collectActionPackages(root)[0].path, 'node_modules');
      const packages = ['alpha', 'beta'].map((name) => {
        const directory = path.join(fixture, 'actions', name);
        fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
        fs.symlinkSync(dependencyRoot, path.join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
        fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ scripts: { lint: 'tsc --noEmit' } }));
        fs.writeFileSync(path.join(directory, 'tsconfig.json'), JSON.stringify({ extends: '../../tsconfig.action.json', include: ['src/**/*.ts', 'tests/**/*.ts'] }));
        fs.writeFileSync(path.join(directory, 'src/global.ts'), 'const isolated: string = "valid";\n');
        return { name, path: directory, tests: [] };
      });
      // Act
      const plan = sourceVerification.batchActionTypecheckPlan(verificationPlan(packages), packages);
      const step = plan.find((entry) => entry.phase === 'typecheck');
      const valid = spawnSync(step.command, step.args, { cwd: step.cwd, encoding: 'utf8' });
      for (const entry of packages) fs.writeFileSync(path.join(entry.path, 'src/global.ts'), 'const isolated: string = 1;\n');
      const invalid = spawnSync(step.command, step.args, { cwd: step.cwd, encoding: 'utf8' });
      // Assert
      expect(plan.filter((entry) => entry.phase === 'typecheck')).toHaveLength(1);
      expect(valid.status, valid.stdout + valid.stderr).toBe(0);
      expect(invalid.status).not.toBe(0);
      for (const entry of packages) expect(invalid.stdout.replaceAll('\\', '/')).toContain('actions/' + entry.name + '/src/global.ts');
      expect(invalid.stdout).toContain('TS2322');
      expect(step.args).toContain('--force');
    });

    // contract_id: contract.repository-action-distribution.source-verification
    // flow_id: repository-action-source-verification
    test('the formal Action source gate rejects type errors independently of bundling', (t) => {
      const parent = path.join(root, 'tests/tmp');
      fs.mkdirSync(parent, { recursive: true });
      const fixture = fs.mkdtempSync(path.join(parent, 'action-typecheck-'));
      t.onTestFinished(() => fs.rmSync(fixture, { recursive: true, force: true }));
      const action = path.join(fixture, 'actions/example');
      fs.mkdirSync(path.join(action, 'node_modules/.bin'), { recursive: true });
      const compiler = path.join(collectActionPackages(root)[0].path, 'node_modules/typescript/bin/tsc');
      fs.symlinkSync(compiler, path.join(action, 'node_modules/.bin/tsc'));
      fs.writeFileSync(path.join(action, 'package.json'), JSON.stringify({ scripts: { lint: 'tsc --noEmit' } }));
      fs.writeFileSync(path.join(action, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, types: [] }, include: ['source.ts'] }));
      const source = path.join(action, 'source.ts');
      const step = verificationPlan([{ name: 'example', path: action, tests: [] }])[0];
      fs.writeFileSync(source, 'export const value: string = "valid";\n');
      const valid = spawnSync(step.command, step.args, { cwd: step.cwd, encoding: 'utf8' });
      fs.writeFileSync(source, 'export const value: string = 1;\n');
      const invalid = spawnSync(step.command, step.args, { cwd: step.cwd, encoding: 'utf8' });
      expect(valid.status, valid.stdout + valid.stderr).toBe(0);
      expect(invalid.status).not.toBe(0);
      expect(invalid.stdout).toContain('TS2322');
    });
  });
});
