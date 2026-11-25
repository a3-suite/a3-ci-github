import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, describe, expect, onTestFinished } from 'vitest';
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

  // contract_id: contract.repository-managed-source-integrity.integrity
  // flow_id: repository-managed-source-integrity-check-failure
  test.each([
    ['repository lint', 'repository-lint'],
    ['rule regression', 'rule-regression'],
    ['workflow contract', 'workflow-contracts'],
  ])('repository lint reports the failed stage when the %s check fails', (failingCheck, stage) => {
    const parent = path.join(root, 'tests/tmp');
    mkdirSync(parent, { recursive: true });
    const fixture = mkdtempSync(path.join(parent, 'managed-source-check-'));
    onTestFinished(() => rmSync(fixture, { recursive: true, force: true }));
    const gate = 'runtime/repository/lint-repository.sh';
    for (const file of [gate, 'runtime/diagnostics/failure.sh']) {
      const target = path.join(fixture, file);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(path.join(root, file), target);
    }
    mkdirSync(path.join(fixture, 'actions/example'), { recursive: true });
    writeFileSync(path.join(fixture, 'actions/example/action.yml'), 'name: example\n');
    // Each stub reports success unless it stands for the failing check, so the gate reaches exactly that check.
    const lint = path.join(fixture, 'stub-lint.sh');
    writeFileSync(lint, failingCheck === 'repository lint' ? '#!/usr/bin/env bash\nexit 1\n' : `#!/usr/bin/env bash
shift; count=0
for argument in "$@"; do [[ "$argument" == --config ]] && break; count=$((count + 1)); done
printf '{"checked_targets":%s,"runtime_errors":[],"diagnostics":[],"trace":{"execution":[{"kind":"rule_executed"}]}}\\n' "$count"
`, { mode: 0o755 });
    mkdirSync(path.join(fixture, 'tests'), { recursive: true });
    writeFileSync(path.join(fixture, 'tests/a3-lint-rule-regression.mjs'), `process.exit(${failingCheck === 'rule regression' ? 1 : 0});\n`);
    writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ scripts: { test: `node -e "process.exit(${failingCheck === 'workflow contract' ? 1 : 0})"` } }));

    const result = spawnSync('bash', [gate], { cwd: fixture, encoding: 'utf8', env: { ...process.env, A3_LINT_BIN: lint } });

    expect(result.status).not.toBe(0);
    const diagnostic = result.stderr.match(/^ci-failure-diagnostic:(.+)$/m);
    expect(diagnostic, result.stderr).not.toBeNull();
    expect(JSON.parse(diagnostic[1]).classification).toMatchObject({ subject: 'repository-managed-source-integrity', stage });
  });
});
