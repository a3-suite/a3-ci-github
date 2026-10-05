import { canonicalJson, fail, record, sha256 } from './io';

export const validateSnapshot = (snapshot: Record<string, unknown>, authority: Record<string, unknown>): Record<string, unknown> => {
  if (snapshot.schema !== 'ci.config-snapshot.v1' || !record(snapshot.values) || !record(snapshot.sources)
    || sha256(Buffer.from(canonicalJson({ sources: snapshot.sources, values: snapshot.values }))) !== snapshot.digest
    || authority.config_snapshot_digest !== snapshot.digest) fail('config-inconsistent');
  return snapshot.values;
};
