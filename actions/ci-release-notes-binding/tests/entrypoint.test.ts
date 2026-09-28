import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';


const root = path.resolve(__dirname, '..');
const createInputs = () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-release-notes-binding-'));
  const body = '# Release v1.2.3\n';
  const digest = crypto.createHash('sha256').update(body).digest('hex');
  fs.writeFileSync(path.join(tempRoot, 'handoff.json'), JSON.stringify({ schema: 'ci.release-notes.v1', source_contract: 'git.release-flow', source_field: 'body', release_identity: 'v1.2.3', body, body_sha256: digest }));
  fs.writeFileSync(path.join(tempRoot, 'approval.json'), JSON.stringify({ schema: 'ci.release-notes-approval.v1', source_contract: 'git.release-flow', source_field: 'body', release_identity: 'v1.2.3', body_sha256: digest, approval_id: 'review-1' }));
  return tempRoot;
};
const runBundled = (tempRoot: string, identity: string) => {
  const output = path.join(tempRoot, 'outputs');
  fs.writeFileSync(output, '', 'utf8');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output } as Record<string, string>;
  env['INPUT_HANDOFF-JSON'] = path.join(tempRoot, 'handoff.json');
  env['INPUT_APPROVAL-JSON'] = path.join(tempRoot, 'approval.json');
  env['INPUT_RELEASE-IDENTITY'] = identity;
  return { output, result: spawnSync(process.execPath, [path.join(root, 'dist/index.js')], { cwd: root, env, encoding: 'utf8' }) };
};

// contract_id: contract.ci-release-notes-binding.outputs
// integration_id: ci-release-notes-binding-contract-entrypoint
test('bundled entrypoint validates an approved notes binding', () => {
  // Arrange
  const tempRoot = createInputs();
  // Act
  const run = runBundled(tempRoot, 'v1.2.3');
  // Assert
  assert.equal(run.result.status, 0);
  assert.match(fs.readFileSync(run.output, 'utf8'), /status<</);
  assert.match(fs.readFileSync(run.output, 'utf8'), /success/);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

// integration_id: ci-release-notes-binding-entrypoint-regression
test('bundled entrypoint fails an identity mismatch', () => {
  // Arrange
  const tempRoot = createInputs();
  // Act
  const run = runBundled(tempRoot, 'v1.2.4');
  // Assert
  assert.notEqual(run.result.status, 0);
  assert.match(fs.readFileSync(run.output, 'utf8'), /failed/);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
