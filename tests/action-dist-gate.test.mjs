import { test, describe, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { assertNoUntrackedDist, assertTrackedReferences, buildPlan, collectActions, runPlan, collectScriptBundles } from '../runtime/repository/check-action-dist.mjs';
import { safeErrorReason } from '../runtime/diagnostics/failure.mjs';
import { root } from "./action-dist-gate.fixtures.mjs";

describe("action-dist-gate", () => {
  describe("repository-action-distribution-regression", () => {
    // integration_id: repository-action-distribution-regression
    test('collects bundled and composite Actions with their distribution contract', () => {
      // Arrange
      const projectRoot = root;
      // Act
      const actions = collectActions(projectRoot);
      // Assert
      expect(actions.length > 0).toBeTruthy();
      expect(new Set(actions.map((action) => action.name)).size).toBe(actions.length);
      for (const action of actions) {
        expect(['node24', 'composite'].includes(action.runtime)).toBeTruthy();
        if (action.runtime === 'node24') expect(action.distPath).toBe(`actions/${action.name}/dist`);
        if (action.name === 'ci-release-supplemental-asset') expect(action.companionDistPaths).toStrictEqual(['runtime/installer/dist']);
        if (action.runtime === 'composite') {
          expect(action.distPath).toBe(null);
          if (action.name === 'ci-quality-toolchain') expect(action.referencedPaths).toStrictEqual([
            'actions/ci-quality-toolchain/scripts/setup-cargo-audit.sh',
            'actions/ci-quality-toolchain/scripts/setup-cargo-deny.sh',
            'runtime/diagnostics/failure.sh',
          ]);
          else expect(action.referencedPaths.length > 0).toBeTruthy();
          for (const relative of action.referencedPaths) expect(existsSync(path.join(root, relative))).toBe(true);
        }
      }
    });
  });
});


describe("contract.repository-action-distribution.integrity", () => {
  describe("repository-action-distribution-gates", () => {

    // contract_id: contract.repository-action-distribution.integrity
    // integration_id: repository-action-distribution-gates
    test('every Action has contract coverage for its public outputs', () => {
      const packageText = readFileSync(path.join(root, 'sdd/dsl/specs/contract-core/contract-package.sdd.yml'), 'utf8');
      const subjectPaths = new Set([...packageText.matchAll(/^ +- subjects\/([^/]+)\/$/gm)].map((match) => match[1]));

      for (const action of collectActions(root)) {
        expect(subjectPaths.has(action.name), `missing contract subject for ${action.name}`).toBe(true);
        const actionText = readFileSync(path.join(root, 'actions', action.name, 'action.yml'), 'utf8');
        const outputSection = actionText.match(/^outputs:\n([\s\S]*?)^runs:/m)?.[1] ?? '';
        const outputs = [...outputSection.matchAll(/^  ([a-z0-9-]+):/gm)].map((match) => match[1]);
        const subjectRoot = path.join(root, 'sdd/dsl/specs/contract-core/subjects', action.name);
        const subject = readFileSync(path.join(subjectRoot, 'subject.sdd.yml'), 'utf8');
        const selectors = new Set([...subject.matchAll(/selector:\s*([a-z0-9-]+)/g)].map((match) => match[1]));
        for (const output of outputs) expect(selectors.has(output), `${action.name} output is not observed: ${output}`).toBe(true);
        for (const contractFile of ['verifications.sdd.yml', 'test-maps.sdd.yml']) {
          expect(existsSync(path.join(subjectRoot, contractFile)), `${action.name} is missing ${contractFile}`).toBe(true);
        }
      }
    });

    // contract_id: contract.repository-action-distribution.integrity
    // integration_id: repository-action-distribution-gates
    test('build plan installs, rebuilds, and compares every Action dist', () => {
      // Arrange
      const actions = [
        { name: 'first', path: '/workspace/actions/first', distPath: 'actions/first/dist', companionDistPaths: ['runtime/installer/dist'] },
        { name: 'second', path: '/workspace/actions/second', distPath: null },
      ];
      // Act
      const plan = buildPlan('/workspace', actions);
      // Assert
      expect(plan).toStrictEqual([
        { command: 'npm', args: ['ci', '--ignore-scripts'], cwd: '/workspace/actions/first', parallelGroup: 'action-install' },
        { command: process.execPath, args: ['/workspace/actions/first/node_modules/typescript/bin/tsc',
          '--project', '/workspace/runtime/diagnostics/tsconfig.json',
          '--typeRoots', '/workspace/actions/first/node_modules/@types'], cwd: '/workspace' },
        { command: 'npm', args: ['run', 'build'], cwd: '/workspace/actions/first', parallelGroup: 'action-build' },
        { command: 'git', args: ['diff', '--exit-code', '--name-only', '--', 'runtime/diagnostics/failure.mjs',
          'runtime/diagnostics/failure.d.mts', 'actions/first/dist', 'runtime/installer/dist'], cwd: '/workspace', failure: 'dist-identity-mismatch' },
      ]);
    });

    // contract_id: contract.repository-action-distribution.integrity
    // integration_id: repository-action-distribution-gates
    test('collects and rebuilds the Rust release script bundle', () => {
      // Arrange
      const projectRoot = root;
      // Act
      const bundles = collectScriptBundles(projectRoot);
      const plan = buildPlan('/workspace', [], [{
        name: 'rust-release-platform-manifest',
        path: '/workspace/runtime/rust-release',
        distPath: 'runtime/rust-release/dist',
      }]);
      // Assert
      expect(bundles.map((bundle) => bundle.name)).toStrictEqual(['rust-release-platform-manifest']);
      expect(bundles.map((bundle) => bundle.distPath)).toStrictEqual(['runtime/rust-release/dist']);
      expect(plan).toStrictEqual([
        { command: 'npm', args: ['ci', '--ignore-scripts'], cwd: '/workspace/runtime/rust-release' },
        { command: 'npm', args: ['run', 'build'], cwd: '/workspace/runtime/rust-release' },
        { command: 'git', args: ['diff', '--exit-code', '--name-only', '--', 'runtime/rust-release/dist'], cwd: '/workspace', failure: 'dist-identity-mismatch' },
      ]);
    });

    // contract_id: contract.repository-action-distribution.integrity
    // integration_id: repository-action-distribution-gates
    test('CI rebuild skips duplicate ncc typechecking while standard build remains unchanged', () => {
      const actions = collectActions(root);
      const bundles = collectScriptBundles(root);
      const standard = buildPlan(root, actions, bundles);
      const ci = buildPlan(root, actions, bundles, { transpileOnly: true });
      const builds = ci.filter((step) => step.command === 'npm' && step.args[0] === 'run');
      for (const action of actions.filter((entry) => entry.distPath)) {
        expect(builds.find((step) => step.cwd === action.path).args).toEqual(['run', 'build', '--', '--transpile-only']);
      }
      expect(builds.find((step) => step.cwd === bundles[0].path).args).toEqual(['run', 'build']);
      expect(standard.filter((step) => step.command === 'npm' && step.args[0] === 'run').every((step) => step.args.length === 2)).toBe(true);
      expect(ci.at(-1)).toEqual(standard.at(-1));
      expect(ci.filter((step) => step.command === process.execPath)).toEqual(standard.filter((step) => step.command === process.execPath));
    });

    // contract_id: contract.repository-action-distribution.integrity
    // integration_id: repository-action-distribution-gates
    test('fails when a build leaves an untracked dist file', () => {
      // Arrange
      const actions = [{ distPath: 'actions/first/dist', companionDistPaths: ['runtime/installer/dist'] }];
      const execute = (command, args) => {
        expect(args).toContain('runtime/installer/dist');
        return 'runtime/installer/dist/extra.js\n';
      };
      let failure;
      // Act
      try { assertNoUntrackedDist('/workspace', actions, [], execute); } catch (error) { failure = error; }
      // Assert
      expect(String(failure)).toMatch(/Untracked distribution files/);
      expect(safeErrorReason(failure)).toBe('dist-untracked');
    });

    // contract_id: contract.repository-action-distribution.integrity
    // integration_id: repository-action-distribution-gates
    test('reports a dist identity mismatch reason and keeps other step failures unchanged', async () => {
      // Arrange
      const childFailure = new Error('exit status 1');
      const execute = () => { throw childFailure; };
      let mismatch;
      let build;
      // Act
      try { await runPlan([{ command: 'git', args: ['diff'], cwd: '/workspace', failure: 'dist-identity-mismatch' }], execute); } catch (error) { mismatch = error; }
      try { await runPlan([{ command: 'npm', args: ['run', 'build'], cwd: '/workspace' }], execute); } catch (error) { build = error; }
      // Assert
      expect(safeErrorReason(mismatch)).toBe('dist-identity-mismatch');
      expect(mismatch.details).toMatchObject({ field: 'dist', observed: 'differs' });
      expect(build).toBe(childFailure);
    });

    // contract_id: contract.repository-action-distribution.integrity
    // integration_id: repository-action-distribution-gates
    test('fails when a Composite Action references an untracked script', () => {
      // Arrange
      const actions = [{ referencedPaths: ['scripts/example/run.sh'] }];
      const execute = (command, args) => {
        expect(command).toBe('git');
        expect(args).toStrictEqual(['ls-files', '--error-unmatch', '--', 'scripts/example/run.sh']);
        throw new Error('pathspec did not match any files');
      };

      let failure;
      // Act
      try { assertTrackedReferences('/workspace', actions, execute); } catch (error) { failure = error; }
      // Assert
      expect(String(failure)).toMatch(/untracked referenced paths.*scripts\/example\/run\.sh/is);
      expect(safeErrorReason(failure)).toBe('composite-reference-untracked');
    });
  });
});



describe('bounded distribution builds', () => {
  describe('runPlan and buildPlan', () => {
    // evidence_role: supplemental
    // test_level: unit
    // target_id: runPlan(plan, execute)
    test.each(['action-install', 'action-build'].flatMap(group => [false, true].map(fail => [group, fail])))('bounds active steps and drains before completion (%s, failure=%s)', async (group, fail) => {
      // Arrange
      const calls = [];
      const pending = new Map();
      let active = 0;
      let peak = 0;
      let completed = false;
      const build = (name) => ({ command: 'build', args: [], cwd: `/actions/${name}`, parallelGroup: group });
      const execute = async (command, args, options) => {
        calls.push(command === 'build' ? options.cwd : command);
        if (command !== 'build') return;
        active++;
        peak = Math.max(peak, active);
        try { await new Promise((resolve, reject) => pending.set(options.cwd, { resolve, reject })); }
        finally { active--; }
      };
      // Act
      const result = runPlan([{ command: 'prepare', args: [], cwd: '/' }, build('a'), build('b'), build('c'),
        { command: 'compare', args: [], cwd: '/' }], execute)
        .then(() => { completed = true; }, (error) => { completed = true; return error; });
      await new Promise((resolve) => setImmediate(resolve));
      // Assert
      expect(calls).toEqual(['prepare', '/actions/a', '/actions/b']);
      if (fail) pending.get('/actions/a').reject(Object.assign(new Error('failed'), { status: 7 }));
      else pending.get('/actions/a').resolve();
      await new Promise((resolve) => setImmediate(resolve));
      expect(completed).toBe(false);
      expect(calls).toEqual(fail ? ['prepare', '/actions/a', '/actions/b'] : ['prepare', '/actions/a', '/actions/b', '/actions/c']);
      pending.get('/actions/b').resolve();
      if (!fail) pending.get('/actions/c').resolve();
      const outcome = await result;
      expect(active).toBe(0);
      expect(peak).toBe(2);
      if (fail) {
        expect(outcome.details).toMatchObject({ action: 'a', observed: 7 });
        expect(calls).not.toContain('compare');
      } else {
        expect(outcome).toBeUndefined();
        expect(calls.at(-1)).toBe('compare');
      }
    });

    // evidence_role: supplemental
    // test_level: unit
    // target_id: buildPlan(root, actions)
    test('rejects overlapping Action output directories before starting builds', () => {
      // Arrange
      const actions = [
        { name: 'a', path: '/a', distPath: 'dist' },
        { name: 'b', path: '/b', distPath: 'dist/nested' },
      ];
      // Act / Assert
      expect(() => buildPlan('/workspace', actions)).toThrow('action-build-output-overlap');
    });
  });
});
