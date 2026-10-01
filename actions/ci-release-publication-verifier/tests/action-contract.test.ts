import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

const root = path.resolve(__dirname, '..');

// contract_id: contract.ci-release-publication-verifier.outputs
// integration_id: release-publication-verifier-action-contract
test('publication verifier owns Node runtime and declares read-only operations', () => {
  const contract = fs.readFileSync(path.join(root, 'action.yml'), 'utf8');
  assert.match(contract, /using: node24\n  main: dist\/index.js/);
  assert.doesNotMatch(contract, /node-version|using: composite/);
  assert.match(contract, /observe-before or verify-after/);
  for (const input of ['operation', 'repository', 'authority-path', 'handoff-root', 'observation-path']) assert.match(contract, new RegExp(`  ${input}:\\n    required: true`));
  for (const output of ['status', 'observation-path', 'observation-digest', 'release-remote-identity', 'publish-receipt', 'readback-evidence']) assert.match(contract, new RegExp(`  ${output}:`));
});
