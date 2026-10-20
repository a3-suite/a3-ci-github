import { test, describe, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { collectActions } from '../runtime/repository/check-action-dist.mjs';
import { root } from "./action-dist-gate.fixtures.mjs";

describe("contract.repository-action-distribution.integrity", () => {
  describe("repository-action-distribution-gates", () => {
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
