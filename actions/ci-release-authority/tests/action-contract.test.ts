import fs from 'node:fs';
import path from 'node:path';
import { describe, test, expect } from 'vitest';
describe('ci-release-authority-action-contract', () => {
  // integration_id: ci-release-authority-action-contract
  test('authority contract uses bundled node24 and explicit read-only inputs', () => {
    const contract = fs.readFileSync(path.resolve(__dirname, '../action.yml'), 'utf8');
    expect(contract).toMatch(/using: node24/);
    expect(contract).toMatch(/main: dist\/index.js/);
    for (const input of ['root-directory', 'snapshot-path', 'output-directory', 'release-request-run-id', 'publication-request-run-id', 'github-token']) expect(contract.includes(`  ${input}:`)).toBeTruthy();
  });
});
