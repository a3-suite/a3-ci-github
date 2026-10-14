import { describe, test, expect } from 'vitest';
import { standardQualityBundle, verifyStandardQualityBundle } from '../../../runtime/adapter/standard-quality-bundles.js';
import { parseAdapterBundle } from '../src/adapter.js';

describe('ci-quality-adapter-standard-selection', () => {
  // contract_id: contract.ci-quality-adapter.outputs
  // integration_id: ci-quality-adapter-standard-selection
  test('fixed standard bundles preserve repository owner metadata and require no copied assets', () => {
    for (const [id, profile] of [['rust-cargo-quality', 'rust'], ['python-uv-quality', 'python'], ['typescript-npm-quality', 'typescript']]) {
      const entry = standardQualityBundle(id);
      const descriptor = parseAdapterBundle(entry.descriptor);
      expect(descriptor.id).toBe(id);
      expect(descriptor.owner).toBe('ci-github');
      expect(descriptor.provider).toBe('provider-neutral');
      expect(descriptor.copyable).toBe(true);
      expect(descriptor.languageProfiles).toStrictEqual([profile]);
      expect(descriptor.assets).toStrictEqual([]);
      expect(entry.sourcePath).toMatch(/^runtime\/adapter\/bundles\/[a-z-]+\.yml$/);
      expect(() => verifyStandardQualityBundle({ ...entry, owner: profile })).toThrow(/standard-bundle-integrity/);
      expect(() => verifyStandardQualityBundle({ ...entry, sourcePath: 'runtime/adapter/bundles/../outside.yml' })).toThrow(/standard-bundle-integrity/);
      expect(() => verifyStandardQualityBundle({ ...entry, descriptor: `${entry.descriptor}\n` })).toThrow(/standard-bundle-integrity/);
    }
    expect(() => standardQualityBundle('unknown')).toThrow(/standard-bundle-unknown/);
  });
});
