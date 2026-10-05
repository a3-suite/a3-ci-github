import { describe, test, expect } from 'vitest';
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

describe('Release evidence schema', () => {
  test('typed evidence witnesses conform to every canonical schema definition', () => {
    expect(Object.keys(samples).sort()).toStrictEqual(Object.keys(evidenceSchema.$defs).sort());
    for (const type of Object.keys(samples) as (keyof typeof samples)[]) {
      const value = samples[type];
      expect(validateEvidence(type, value)).toStrictEqual(value);
      const rule = evidenceSchema.$defs[type];
      if (!record(value)) continue;
      expect(Object.keys(value).sort()).toStrictEqual([...(rule.required ?? [])].sort());
      expect(() => validateEvidence(type, { ...value, unexpected: true })).toThrow(/schema-mismatch/);
      for (const field of rule.required ?? []) {
        const missing: Record<string, unknown> = { ...value };
        delete missing[field];
        expect(() => validateEvidence(type, missing)).toThrow(/schema-mismatch/);
        expect(() => validateEvidence(type, { ...value, [field]: null })).toThrow(/schema-mismatch/);
      }
    }
    const after = { ...observation, phase: 'post-create' } satisfies ObservationType;
    expect(validateEvidence('observation', after)).toStrictEqual(after);
  });
});
