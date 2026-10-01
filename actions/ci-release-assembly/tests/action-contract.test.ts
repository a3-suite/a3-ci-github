import fs from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';

const root = path.resolve(__dirname, '..');

// contract_id: contract.ci-release-assembly.outputs
// integration_id: release-assembly-action-contract
test('assembly Action owns its Node runtime and exposes bounded assembly inputs', () => {
  const contract = fs.readFileSync(path.join(root, 'action.yml'), 'utf8');
  assert.match(contract, /using: node24\n  main: dist\/index.js/);
  assert.doesNotMatch(contract, /node-version|using: composite/);
  for (const input of ['authority-path', 'snapshot-path', 'platform-manifest-path', 'platform-matrix', 'build-root', 'output-directory']) assert.match(contract, new RegExp(`  ${input}:\\n    required: true`));
  for (const output of ['status', 'release-handoff', 'asset-digest']) assert.match(contract, new RegExp(`  ${output}:`));
});
