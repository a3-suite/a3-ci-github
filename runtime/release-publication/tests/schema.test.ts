import assert from 'node:assert/strict';
import { test } from 'vitest';
import { evidenceSchema, validateEvidence } from '../schema';
import type { ReleaseIdentityType, AssetType, AssemblyType, ObservationType, ReceiptType, ReadbackType } from '../schema';
import { record } from '../io';

const digest = 'a'.repeat(64);
const identity = { repository: 'owner/project', tag: 'v1.0.0', tag_object_sha: 'b'.repeat(40), source_sha: 'c'.repeat(40), version: '1.0.0', target_identity: 'owner/project', body_sha256: digest } satisfies ReleaseIdentityType;
const asset = { name: 'archive.tar.gz', size: 1, sha256: digest } satisfies AssetType;
const assembly = { schema_version: '1', kind: 'ci-github-release-assembly', identity, assets: [asset], asset_digest: digest, manifest_sha256: digest } satisfies AssemblyType;
const observation = { schema_version: '1', kind: 'ci-github-release-observation', identity, handoff_digest: digest, phase: 'pre-create', complete: true, visibility: 'public-and-non-public', release_ids: [] } satisfies ObservationType;
const receipt = { schema_version: '1', kind: 'ci-github-release-publish-receipt', identity, handoff_digest: digest, asset_digest: digest, release_id: '42', pre_observation_sha256: digest } satisfies ReceiptType;
const readback = { schema_version: '1', kind: 'ci-github-release-readback', identity, handoff_digest: digest, asset_digest: digest, release_id: '42', draft: false, assets: [asset], inventory: { ...observation, phase: 'post-create', release_ids: ['42'] } } satisfies ReadbackType;
const samples = { identity, asset, assets: [asset], assembly, observation, receipt, readback, sourceSha: identity.source_sha, digest, remoteId: '42', name: asset.name };

test('typed evidence witnesses conform to every canonical schema definition', () => {
  assert.deepEqual(Object.keys(samples).sort(), Object.keys(evidenceSchema.$defs).sort());
  for (const type of Object.keys(samples) as (keyof typeof samples)[]) {
    const value = samples[type];
    assert.deepEqual(validateEvidence(type, value), value);
    const rule = evidenceSchema.$defs[type];
    if (!record(value)) continue;
    assert.deepEqual(Object.keys(value).sort(), [...(rule.required ?? [])].sort());
    assert.throws(() => validateEvidence(type, { ...value, unexpected: true }), /schema-mismatch/);
    for (const field of rule.required ?? []) {
      const missing: Record<string, unknown> = { ...value };
      delete missing[field];
      assert.throws(() => validateEvidence(type, missing), /schema-mismatch/);
      assert.throws(() => validateEvidence(type, { ...value, [field]: null }), /schema-mismatch/);
    }
  }
  const after = { ...observation, phase: 'post-create' } satisfies ObservationType;
  assert.deepEqual(validateEvidence('observation', after), after);
});
