import { test, describe, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertNoUntrackedDist,
  assertTrackedReferences,
  buildPlan,
  collectActions,
  collectScriptBundles,
} from '../runtime/repository/check-action-dist.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
          if (action.name === 'ci-quality-toolchain') expect(action.referencedPaths).toStrictEqual([]);
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
      const subjectPaths = new Set([...packageText.matchAll(/^    path: subjects\/([^/]+)\/$/gm)].map((match) => match[1]));

      for (const action of collectActions(root)) {
        expect(subjectPaths.has(action.name), `missing contract subject for ${action.name}`).toBe(true);
        const actionText = readFileSync(path.join(root, 'actions', action.name, 'action.yml'), 'utf8');
        const outputSection = actionText.match(/^outputs:\n([\s\S]*?)^runs:/m)?.[1] ?? '';
        const outputs = [...outputSection.matchAll(/^  ([a-z0-9-]+):/gm)].map((match) => match[1]);
        const subjectRoot = path.join(root, 'sdd/dsl/specs/contract-core/subjects', action.name);
        const observations = readFileSync(path.join(subjectRoot, 'observations.sdd.yml'), 'utf8');
        const selectors = new Set([...observations.matchAll(/selector:\s*([a-z0-9-]+)/g)].map((match) => match[1]));
        for (const output of outputs) expect(selectors.has(output), `${action.name} output is not observed: ${output}`).toBe(true);
        for (const contractFile of ['clauses.sdd.yml', 'verifications.sdd.yml', 'test-maps.sdd.yml']) {
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
        { command: 'npm', args: ['ci', '--ignore-scripts'], cwd: '/workspace/actions/first' },
        { command: 'npm', args: ['run', 'build'], cwd: '/workspace/actions/first' },
        { command: 'git', args: ['diff', '--exit-code', '--', 'actions/first/dist', 'runtime/installer/dist'], cwd: '/workspace' },
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
        { command: 'git', args: ['diff', '--exit-code', '--', 'runtime/rust-release/dist'], cwd: '/workspace' },
      ]);
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
    });
  });
});
