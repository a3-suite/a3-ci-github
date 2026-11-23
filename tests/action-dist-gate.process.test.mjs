import { test, describe, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { collectActions } from '../runtime/repository/check-action-dist.mjs';
import { root } from "./action-dist-gate.fixtures.mjs";

describe("contract.repository-action-distribution.integrity", () => {
  describe("repository-action-distribution-gates", () => {
    // evidence_role: supplemental
    // Regenerating the diagnostic runtime with tsc is a build mechanism of the repository, not an observation of the distribution integrity guarantee.
    // contract_id: contract.repository-action-distribution.integrity
    // flow_id: repository-action-distribution-gates
    test('diagnostic runtime regenerates native JavaScript and declarations from strict source', () => {
      const temporaryRoot = path.join(root, 'tests/tmp');
      mkdirSync(temporaryRoot, { recursive: true });
      const fixture = mkdtempSync(path.join(temporaryRoot, 'diagnostic-generation-'));
      const action = collectActions(root).find((entry) => entry.distPath);
      const compiler = path.join(action.path, 'node_modules/typescript/bin/tsc');
      const types = path.join(action.path, 'node_modules/@types');
      try {
        const generated = spawnSync(process.execPath, [compiler, '--project', path.join(root, 'runtime/diagnostics/tsconfig.json'),
          '--typeRoots', types, '--outDir', path.join(fixture, 'generated'), '--listFiles'], { encoding: 'utf8' });
        expect(generated.status, generated.stdout + generated.stderr).toBe(0);
        expect(generated.stdout).toContain(path.join(root, 'runtime/diagnostics/failure.mts'));
        for (const file of ['failure.mjs', 'failure.d.mts']) {
          expect(readFileSync(path.join(fixture, 'generated', file))).toEqual(readFileSync(path.join(root, 'runtime/diagnostics', file)));
        }
        writeFileSync(path.join(fixture, 'untyped.mts'), 'export const invalid = (value) => value;\n');
        writeFileSync(path.join(fixture, 'tsconfig.json'), JSON.stringify({
          extends: path.join(root, 'runtime/diagnostics/tsconfig.json'),
          compilerOptions: { rootDir: fixture, noEmit: true }, include: ['untyped.mts'],
        }));
        const rejected = spawnSync(process.execPath, [compiler, '--project', path.join(fixture, 'tsconfig.json'), '--typeRoots', types], { encoding: 'utf8' });
        expect(rejected.status).not.toBe(0);
        expect(rejected.stdout).toContain('TS7006');
      } finally { rmSync(fixture, { recursive: true, force: true }); }
    });

    // evidence_role: supplemental
    // Forwarding the CI option to ncc is a build mechanism of the installer, not an observation of the distribution integrity guarantee.
    // contract_id: contract.repository-action-distribution.integrity
    // flow_id: repository-action-distribution-gates
    test('installer build forwards the CI option to both ncc entries without changing normal builds', (t) => {
      const parent = path.join(root, 'tests/tmp');
      mkdirSync(parent, { recursive: true });
      const fixture = mkdtempSync(path.join(parent, 'installer-build-options-'));
      t.onTestFinished(() => rmSync(fixture, { recursive: true, force: true }));
      const installer = path.join(fixture, 'runtime/installer');
      const action = path.join(fixture, 'actions/ci-release-supplemental-asset');
      const compiler = path.join(action, 'node_modules/@vercel/ncc/dist/ncc/cli.js');
      mkdirSync(installer, { recursive: true });
      mkdirSync(path.dirname(compiler), { recursive: true });
      writeFileSync(path.join(installer, 'build-distribution.mjs'), readFileSync(path.join(root, 'runtime/installer/build-distribution.mjs')));
      writeFileSync(compiler, `require('node:fs').appendFileSync(process.env.BUILD_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');`);
      for (const file of ['src/diagnostic-reasons.json', 'src/assembly.py', 'src/build-installer.py', 'src/build-shared-wrapper.py', 'src/builder_common.py', 'src/platform/install.sh', 'src/platform/install.ps1', 'src/wrapper/install.sh']) {
        const filename = path.join(installer, file);
        mkdirSync(path.dirname(filename), { recursive: true });
        writeFileSync(filename, 'fixture');
      }
      for (const flags of [[], ['--transpile-only']]) {
        const calls = path.join(fixture, flags.length ? 'ci.jsonl' : 'normal.jsonl');
        const result = spawnSync(process.execPath, [path.join(installer, 'build-distribution.mjs'), ...flags], {
          encoding: 'utf8', env: { ...process.env, BUILD_CALLS: calls },
        });
        expect(result.status, result.stderr).toBe(0);
        const entries = readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        expect(entries).toHaveLength(2);
        for (const args of entries) expect(args.includes('--transpile-only')).toBe(flags.length === 1);
      }
    });
  });
});

describe("contract.repository-action-distribution.integrity", () => {
  describe("repository-action-distribution-gates", () => {
    // The gate checks the repository that contains it, so each case copies the gate into a fixture repository.
    // A stub npm on PATH stands in for dependency installation and builds; the build stub writes the configured file.
    const gateFixture = (t, { buildWrites } = {}) => {
      const temporaryRoot = path.join(root, 'tests/tmp');
      mkdirSync(temporaryRoot, { recursive: true });
      const fixture = mkdtempSync(path.join(temporaryRoot, 'action-dist-gate-'));
      t.onTestFinished(() => rmSync(fixture, { recursive: true, force: true }));
      const write = (relative, content, mode) => {
        mkdirSync(path.dirname(path.join(fixture, relative)), { recursive: true });
        writeFileSync(path.join(fixture, relative), content, mode ? { mode } : undefined);
      };
      for (const relative of ['runtime/repository/check-action-dist.mjs', 'runtime/diagnostics/failure.mjs']) write(relative, readFileSync(path.join(root, relative)));
      for (const relative of ['package.json', 'src/verify-platform-manifest.mjs', 'dist/index.mjs']) write(`runtime/rust-release/${relative}`, '{}\n');
      write('actions/composite/action.yml', 'name: composite\nruns:\n  using: composite\n  steps:\n    - run: "${GITHUB_ACTION_PATH}/run.sh"\n      shell: bash\n');
      write('actions/composite/README.md', '# composite\n');
      write('actions/composite/run.sh', '#!/bin/sh\n', 0o755);
      write('bin/npm', `#!/bin/sh\nif [ "$1" = run ] && [ -n "$STUB_BUILD_WRITES" ]; then mkdir -p "$(dirname "$STUB_BUILD_WRITES")"; echo generated > "$STUB_BUILD_WRITES"; fi\n`, 0o755);
      const git = (...args) => spawnSync('git', args, { cwd: fixture, encoding: 'utf8' });
      git('init', '-q'); git('add', '.');
      git('-c', 'user.name=Gate Test', '-c', 'user.email=gate@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
      const run = () => {
        const result = spawnSync(process.execPath, [path.join(fixture, 'runtime/repository/check-action-dist.mjs')], { cwd: fixture, encoding: 'utf8',
          env: { ...process.env, PATH: `${path.join(fixture, 'bin')}${path.delimiter}${process.env.PATH}`, STUB_BUILD_WRITES: buildWrites ? path.join(fixture, buildWrites) : '' } });
        const line = result.stderr.split('\n').find((value) => value.startsWith('ci-failure-diagnostic:'));
        return { status: result.status, evidence: line ? JSON.parse(line.slice('ci-failure-diagnostic:'.length)) : undefined };
      };
      return { fixture, git, write, run };
    };

    // contract_id: contract.repository-action-distribution.integrity
    // flow_id: repository-action-distribution-gates
    test('gate CLI accepts a consistent distribution', (t) => {
      const accepted = gateFixture(t);
      expect(accepted.run().status).toBe(0);
    });

    // contract_id: contract.repository-action-distribution.integrity
    // flow_id: repository-action-distribution-gates
    test('gate CLI rejects a build that leaves an untracked dist file', (t) => {
      const gate = gateFixture(t, { buildWrites: 'runtime/rust-release/dist/extra.mjs' });
      const rejected = gate.run();
      expect(rejected.status).not.toBe(0);
      expect(rejected.evidence.classification).toMatchObject({ subject: 'repository-action-distribution', stage: 'distribution-inventory', reason: 'dist-untracked' });
      expect(rejected.evidence.comparison).toMatchObject({ field: 'tracked-dist', expected: 'tracked', observed: 'untracked' });
    });

    // contract_id: contract.repository-action-distribution.integrity
    // flow_id: repository-action-distribution-gates
    test('gate CLI rejects a Composite Action that references an untracked script', (t) => {
      const gate = gateFixture(t);
      gate.git('rm', '-q', '--cached', 'actions/composite/run.sh');
      gate.git('-c', 'user.name=Gate Test', '-c', 'user.email=gate@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'untrack script');
      const rejected = gate.run();
      expect(rejected.status).not.toBe(0);
      expect(rejected.evidence.classification).toMatchObject({ subject: 'repository-action-distribution', stage: 'execution-closure', reason: 'composite-reference-untracked' });
      expect(rejected.evidence['execution-state'].write).toBe('not-started');
    });
  });
});
