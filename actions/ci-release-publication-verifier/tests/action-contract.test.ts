import fs from 'node:fs';
import path from 'node:path';
import { describe, test, expect } from 'vitest';

const root = path.resolve(__dirname, '..');

describe('release-publication-verifier-action-contract', () => {
  // contract_id: contract.ci-release-publication-verifier.outputs
  // integration_id: release-publication-verifier-action-contract
  test('publication verifier owns Node runtime and declares read-only operations', () => {
    const contract = fs.readFileSync(path.join(root, 'action.yml'), 'utf8');
    expect(contract).toMatch(/using: node24\n  main: dist\/index.js/);
    expect(contract).not.toMatch(/node-version|using: composite/);
    expect(contract).toMatch(/observe-before or verify-after/);
    for (const input of ['operation', 'repository', 'authority-path', 'handoff-root', 'observation-path']) expect(contract).toMatch(new RegExp(`  ${input}:\\n    required: true`));
    for (const output of ['status', 'observation-path', 'observation-digest', 'release-remote-identity', 'publish-receipt', 'readback-evidence']) expect(contract).toMatch(new RegExp(`  ${output}:`));
  });
});
