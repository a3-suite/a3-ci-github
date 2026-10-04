import fs from 'node:fs';
import { describe, test, expect } from 'vitest';
import path from 'node:path';

const root = path.resolve(__dirname, '..');

describe('release-assembly-action-contract', () => {
  // contract_id: contract.ci-release-assembly.outputs
  // integration_id: release-assembly-action-contract
  test('assembly Action owns its Node runtime and exposes bounded assembly inputs', () => {
    const contract = fs.readFileSync(path.join(root, 'action.yml'), 'utf8');
    expect(contract).toMatch(/using: node24\n  main: dist\/index.js/);
    expect(contract).not.toMatch(/node-version|using: composite/);
    for (const input of ['authority-path', 'snapshot-path', 'platform-manifest-path', 'platform-matrix', 'build-root', 'output-directory']) expect(contract).toMatch(new RegExp(`  ${input}:\\n    required: true`));
    for (const output of ['status', 'release-handoff', 'asset-digest']) expect(contract).toMatch(new RegExp(`  ${output}:`));
  });
});
