import assert from 'node:assert/strict';
import { test } from 'vitest';
import { standardQualityBundle, verifyStandardQualityBundle } from '../../../runtime/adapter/standard-quality-bundles.js';
import { parseAdapterBundle } from '../src/adapter.js';

// contract_id: contract.ci-quality-adapter.outputs
// integration_id: ci-quality-adapter-standard-selection
test('fixed standard bundles preserve language owner metadata and require no copied assets', () => {
  for (const [id, profile] of [['rust-cargo-quality', 'rust'], ['python-uv-quality', 'python'], ['typescript-npm-quality', 'typescript']]) {
    const entry = standardQualityBundle(id);
    const descriptor = parseAdapterBundle(entry.descriptor);
    assert.equal(descriptor.id, id);
    assert.equal(descriptor.owner, profile);
    assert.deepEqual(descriptor.languageProfiles, [profile]);
    assert.deepEqual(descriptor.assets, []);
    assert.match(entry.sourceRevision, /^[a-f0-9]{40}$/);
    assert.throws(() => verifyStandardQualityBundle({ ...entry, descriptor: `${entry.descriptor}\n` }), /standard-bundle-integrity/);
  }
  assert.throws(() => standardQualityBundle('unknown'), /standard-bundle-unknown/);
});
