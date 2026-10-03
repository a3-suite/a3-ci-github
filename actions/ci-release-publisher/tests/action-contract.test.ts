import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'vitest';

// contract_id: contract.ci-release-publisher.outputs
// integration_id: release-publisher-action-contract
test('publisher declares bounded write inputs and evidence paths without success authority', () => {
  const contract = fs.readFileSync(path.resolve(__dirname, '../action.yml'), 'utf8');
  assert.match(contract, /using: node24\n  main: dist\/index.js/);
  for (const name of ['authority-path', 'release-handoff-root', 'pre-observation-path', 'write-output-directory']) {
    assert.match(contract, new RegExp(`  ${name}:\\n    description: [^\\n]+\\n    required: true`));
  }
  assert.match(contract, /  receipt-path:/);
  assert.match(contract, /  readback-path:/);
  assert.doesNotMatch(contract, /  status:|  command:|  credential-route:/);
});
