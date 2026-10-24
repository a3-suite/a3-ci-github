import fs from 'node:fs';
import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parse } from 'yaml';

const root = path.resolve(__dirname, '..');

describe('release-assembly-action-contract', () => {
  // contract_id: contract.ci-release-assembly.outputs
  // integration_id: release-assembly-action-contract
  test('assembly Action owns its Node runtime and exposes bounded assembly inputs', () => {
    const contract = fs.readFileSync(path.join(root, 'action.yml'), 'utf8');
    expect(contract).toMatch(/using: node24\n  main: dist\/index.js/);
    expect(contract).not.toMatch(/node-version|using: composite/);
    for (const input of ['authority-path', 'snapshot-path', 'output-directory']) expect(contract).toMatch(new RegExp(`  ${input}:\\n    required: true`));
    // Build inputs are empty only for an asset release; the runtime requires them for a platform release.
    for (const input of ['platform-manifest-path', 'platform-matrix', 'build-root']) expect(contract).toMatch(new RegExp(`  ${input}:\\n    required: false\\n    default: ''`));
    for (const output of ['status', 'release-handoff', 'asset-digest']) expect(contract).toMatch(new RegExp(`  ${output}:`));
    // Assembly must not be able to write to the provider, so its interface accepts no credential.
    const inputs = Object.keys(parse(contract).inputs);
    expect(inputs).toStrictEqual(['repository', 'authority-path', 'snapshot-path', 'platform-manifest-path', 'platform-matrix', 'build-root', 'supplemental-root', 'skills-source-root', 'output-directory']);
    expect(contract).not.toMatch(/token|credential|secret|password/i);
  });
});
