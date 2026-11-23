import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, describe, expect } from 'vitest';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
describe("repository-managed-source-integrity", () => {
  // flow_id: repository-managed-source-integrity
  test('repository lint rejects each registered legacy source location', (t) => {
    const parent = path.join(root, 'tests/tmp');
    mkdirSync(parent, { recursive: true });
    const fixture = mkdtempSync(path.join(parent, 'legacy-source-'));
    t.onTestFinished(() => rmSync(fixture, { recursive: true, force: true }));
    const gate = 'runtime/repository/lint-repository.sh';
    for (const file of [gate, 'runtime/diagnostics/failure.sh']) {
      const target = path.join(fixture, file);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(path.join(root, file), target);
    }

    for (const relative of ['scripts/ci-github', 'scripts/rust-release', 'skills/ci/ci-github']) {
      const legacy = path.join(fixture, relative);
      mkdirSync(legacy, { recursive: true });
      const existing = path.join(legacy, 'existing.txt');
      const contents = Buffer.from('existing source bytes\n');
      writeFileSync(existing, contents);
      const result = spawnSync('bash', [gate], { cwd: fixture, encoding: 'utf8' });
      expect(result.status).toBe(1);
      const diagnostic = result.stderr.match(/^ci-failure-diagnostic:(.+)$/m);
      expect(diagnostic, result.stderr).not.toBeNull();
      expect(JSON.parse(diagnostic[1])).toMatchObject({
        classification: { stage: 'managed-source-layout' },
        comparison: { field: 'legacy-source-location', expected: 'absent', observed: relative },
      });
      expect(readFileSync(existing)).toStrictEqual(contents);
      rmSync(legacy, { recursive: true });
    }
  });
});
