import { test, describe, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
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

    // evidence_role: supplemental
    // SDD coverage of Action outputs is a repository maintenance check that no distribution integrity guarantee covers.
    // integration_id: repository-action-distribution-gates
    test('every Action has contract coverage for its public outputs', () => {
      const packageText = readFileSync(path.join(root, 'sdd/dsl/specs/contract-core/contract-package.sdd.yml'), 'utf8');
      const subjectPaths = new Set([...packageText.matchAll(/^ +- subjects\/([^/]+)\/$/gm)].map((match) => match[1]));

      for (const action of collectActions(root)) {
        expect(subjectPaths.has(action.name), `missing contract subject for ${action.name}`).toBe(true);
        const actionDefinition = yaml.parse(readFileSync(path.join(root, 'actions', action.name, 'action.yml'), 'utf8'));
        const outputs = Object.keys(actionDefinition.outputs ?? {});
        const subjectRoot = path.join(root, 'sdd/dsl/specs/contract-core/subjects', action.name);
        const subject = yaml.parse(readFileSync(path.join(subjectRoot, 'subject.sdd.yml'), 'utf8'));
        const guarantees = subject.contracts.flatMap((contract) => contract.guarantees)
          .filter(({ boundary }) => boundary === 'boundary.action-output');
        for (const output of outputs) {
          const field = `\`${output}\``;
          const observed = guarantees.some(({ statement }) => {
            const [, observableFields] = statement.split(' Observable fields at this boundary also include ');
            const outputClauses = statement.matchAll(/((?:`[\w-]+`(?:,? (?:and )?(?=`[\w-]+`))?)+) (?:outputs? )?(?:is|equals?|identif(?:y|ies)|reports?|contains?|names?)\b/g);
            return Array.from(outputClauses).some(([, fields]) => fields.includes(field))
              || (observableFields?.includes(`${field} (`) ?? false);
          });
          expect(observed, `${action.name} output is not observed: ${output}`).toBe(true);
        }
        expect(existsSync(path.join(subjectRoot, 'test-maps.sdd.yml')), `${action.name} is missing test-maps.sdd.yml`).toBe(true);
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
