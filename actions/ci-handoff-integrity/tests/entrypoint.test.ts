import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';


const root = path.resolve(__dirname, '..');
const createHandoff = () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-handoff-integrity-'));
  const body = 'payload';
  fs.writeFileSync(path.join(tempRoot, 'artifact.bin'), body);
  const digest = crypto.createHash('sha256').update(body).digest('hex');
  fs.writeFileSync(path.join(tempRoot, 'manifest.json'), JSON.stringify([{ path: 'artifact.bin', sha256: digest }]));
  fs.writeFileSync(path.join(tempRoot, 'handoff.json'), JSON.stringify({ schema: 'ci.handoff.v1', source_sha: 'source', version: '1.0.0', target_identity: 'linux', manifest: 'manifest.json' }));
  return tempRoot;
};
const runBundled = (handoffRoot: string, sourceSha: string) => {
  const output = path.join(handoffRoot, 'outputs');
  fs.writeFileSync(output, '', 'utf8');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output } as Record<string, string>;
  env['INPUT_HANDOFF-ROOT'] = handoffRoot;
  env['INPUT_DESCRIPTOR'] = 'handoff.json';
  env['INPUT_SOURCE-SHA'] = sourceSha;
  env['INPUT_VERSION'] = '1.0.0';
  env['INPUT_TARGET-IDENTITY'] = 'linux';
  return { output, result: spawnSync(process.execPath, [path.join(root, 'dist/index.js')], { cwd: root, env, encoding: 'utf8' }) };
};

// contract_id: contract.ci-handoff-integrity.outputs
// integration_id: ci-handoff-integrity-contract-entrypoint
test('bundled entrypoint validates a handoff', () => {
  // Arrange
  const handoffRoot = createHandoff();
  // Act
  const run = runBundled(handoffRoot, 'source');
  // Assert
  assert.equal(run.result.status, 0);
  assert.match(fs.readFileSync(run.output, 'utf8'), /status<</);
  assert.match(fs.readFileSync(run.output, 'utf8'), /success/);
  fs.rmSync(handoffRoot, { recursive: true, force: true });
});

// integration_id: ci-handoff-integrity-entrypoint-regression
test('bundled entrypoint fails an identity mismatch', () => {
  // Arrange
  const handoffRoot = createHandoff();
  // Act
  const run = runBundled(handoffRoot, 'other');
  // Assert
  assert.notEqual(run.result.status, 0);
  assert.match(fs.readFileSync(run.output, 'utf8'), /failed/);
  fs.rmSync(handoffRoot, { recursive: true, force: true });
});
