import { describe, test, expect } from 'vitest';
import { standardQualityBundle, verifyStandardQualityBundle } from '../../../runtime/adapter/standard-quality-bundles.js';
import { parseAdapterBundle } from '../src/adapter.js';

describe('ci-quality-adapter-standard-selection', () => {
  // contract_id: contract.ci-quality-adapter.outputs
  // integration_id: ci-quality-adapter-standard-selection
  test('fixed standard bundles preserve language owner metadata and require no copied assets', () => {
    for (const [id, profile] of [['rust-cargo-quality', 'rust'], ['python-uv-quality', 'python'], ['typescript-npm-quality', 'typescript']]) {
      const entry = standardQualityBundle(id);
      const descriptor = parseAdapterBundle(entry.descriptor);
      expect(descriptor.id).toBe(id);
      expect(descriptor.owner).toBe(profile);
      expect(descriptor.languageProfiles).toStrictEqual([profile]);
      expect(descriptor.assets).toStrictEqual([]);
      expect(entry.sourceRevision).toMatch(/^[a-f0-9]{40}$/);
      expect(() => verifyStandardQualityBundle({ ...entry, descriptor: `${entry.descriptor}\n` })).toThrow(/standard-bundle-integrity/);
    }
    expect(() => standardQualityBundle('unknown')).toThrow(/standard-bundle-unknown/);
  });
});
