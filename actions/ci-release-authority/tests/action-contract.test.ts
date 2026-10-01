import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
// integration_id: ci-release-authority-action-contract
test('authority contract uses bundled node24 and explicit read-only inputs', () => {
  const contract = fs.readFileSync(path.resolve(__dirname, '../action.yml'), 'utf8');
  assert.match(contract, /using: node24/);
  assert.match(contract, /main: dist\/index.js/);
  for (const input of ['root-directory', 'snapshot-path', 'output-directory', 'release-request-run-id', 'publication-request-run-id', 'github-token']) assert.ok(contract.includes(`  ${input}:`));
});
