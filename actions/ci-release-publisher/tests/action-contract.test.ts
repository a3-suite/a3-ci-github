import fs from 'node:fs';
import path from 'node:path';
import { describe, test, expect } from 'vitest';

describe('release-publisher-action-contract', () => {
  // contract_id: contract.ci-release-publisher.outputs
  // integration_id: release-publisher-action-contract
  test('publisher declares bounded write inputs and evidence paths without success authority', () => {
    const contract = fs.readFileSync(path.resolve(__dirname, '../action.yml'), 'utf8');
    expect(contract).toMatch(/using: node24\n  main: dist\/index.js/);
    for (const name of ['authority-path', 'release-handoff-root', 'pre-observation-path', 'write-output-directory']) {
      expect(contract).toMatch(new RegExp(`  ${name}:\\n    description: [^\\n]+\\n    required: true`));
    }
    expect(contract).toMatch(/  receipt-path:/);
    expect(contract).toMatch(/  readback-path:/);
    expect(contract).not.toMatch(/  status:|  command:|  credential-route:/);
  });
});
