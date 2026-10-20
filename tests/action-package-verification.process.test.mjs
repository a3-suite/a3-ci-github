import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test, describe, expect } from 'vitest';
import * as sourceVerification from '../runtime/repository/verify-action-packages.mjs';
import { collectActionPackages, verificationPlan } from '../runtime/repository/verify-action-packages.mjs';
import { root } from "./action-package-verification.fixtures.mjs";

describe('repository-cli-source-verification', () => {
  describe('cliTypecheckPlan', () => {
    // contract_id: contract.repository-action-distribution.integrity
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


describe("contract.repository-action-distribution.integrity", () => {
  describe("repository-action-source-verification", () => {

    // contract_id: contract.repository-action-distribution.integrity
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

    // contract_id: contract.repository-action-distribution.integrity
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
