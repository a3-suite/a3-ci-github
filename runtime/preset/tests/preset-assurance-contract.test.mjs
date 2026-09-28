import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const bootstrapPath = 'runtime/preset/run-validate-ci-preset.mjs';
const run = (args) => spawnSync(process.execPath, [bootstrapPath, ...args], { cwd: root, encoding: 'utf8' });
const diagnosticOf = (result) => {
  assert.equal(result.status, 2);
  const diagnostic = JSON.parse(result.stderr.trim());
  assert.deepEqual(Object.keys(diagnostic), ['schemaVersion', 'kind', 'outcome', 'reason', 'message']);
  assert.equal(diagnostic.kind, 'ci-github-preflight-bootstrap');
  return diagnostic;
};

// integration_id: preset-assurance-contract
// integration_id: failure-diagnostics-contract
test('preset assurance rejects a request without explicit roots', () => {
  const diagnostic = diagnosticOf(run(['--audit-mode', 'read-only']));
  assert.equal(diagnostic.outcome, 'cannot-start');
  assert.equal(diagnostic.reason, 'invalid-input');
  assert.match(diagnostic.message, /--repo-root is required/);
});

// integration_id: preset-assurance-contract
test('preset assurance rejects remediation output in read-only mode', () => {
  const diagnostic = diagnosticOf(run([
    '--audit-mode', 'read-only',
    '--repo-root', '.',
    '--skill-collection-root', '.',
    '--output', 'report.json',
  ]));
  assert.equal(diagnostic.outcome, 'cannot-start');
  assert.equal(diagnostic.reason, 'invalid-input');
  assert.match(diagnostic.message, /--output is not allowed in read-only mode/);
});
