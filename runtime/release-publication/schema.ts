import schema from './evidence.schema.json';
import { fail, record, sha256, readRecord } from './io';

export type ReleaseIdentityType = {
  repository: string; tag: string; tag_object_sha: string; source_sha: string;
  version: string; target_identity: string; body_sha256: string;
};
export type AssetType = { name: string; sha256: string; size: number };
export type AssemblyType = {
  schema_version: '1'; kind: 'ci-github-release-assembly'; identity: ReleaseIdentityType;
  assets: AssetType[]; asset_digest: string; manifest_sha256: string;
};
export type ObservationType = {
  schema_version: '1'; kind: 'ci-github-release-observation'; identity: ReleaseIdentityType;
  handoff_digest: string; phase: 'pre-create' | 'post-create'; complete: true;
  visibility: 'public-and-non-public'; release_ids: string[];
};
export type ReceiptType = {
  schema_version: '1'; kind: 'ci-github-release-publish-receipt'; identity: ReleaseIdentityType;
  handoff_digest: string; asset_digest: string; release_id: string; pre_observation_sha256: string;
};
export type ReadbackType = {
  schema_version: '1'; kind: 'ci-github-release-readback'; identity: ReleaseIdentityType;
  handoff_digest: string; asset_digest: string; release_id: string; draft: false;
  assets: AssetType[]; inventory: ObservationType;
};
type EvidenceTypesType = {
  identity: ReleaseIdentityType; asset: AssetType; assets: AssetType[]; assembly: AssemblyType;
  observation: ObservationType; receipt: ReceiptType; readback: ReadbackType;
  sourceSha: string; digest: string; remoteId: string; name: string;
};
type SchemaRuleType = {
  $ref?: string; const?: unknown; enum?: unknown[]; type?: string; pattern?: string;
  minLength?: number; maxLength?: number; minimum?: number; maximum?: number;
  minItems?: number; maxItems?: number; items?: SchemaRuleType;
  required?: string[]; additionalProperties?: boolean; properties?: Record<string, SchemaRuleType>;
};
export const evidenceSchema: { $defs: Record<string, SchemaRuleType> } = schema;
const validate = (value: unknown, rule: SchemaRuleType, location: string): void => {
  if (rule.$ref) {
    const referred = evidenceSchema.$defs[rule.$ref.replace('#/$defs/', '')];
    if (!referred) fail('schema-type-unknown');
    return validate(value, referred, location);
  }
  if ('const' in rule && value !== rule.const) fail(`schema-mismatch:${location}`);
  if (rule.enum && !rule.enum.includes(value)) fail(`schema-mismatch:${location}`);
  if (rule.type === 'string' && (typeof value !== 'string' || value.length < (rule.minLength ?? 0)
    || value.length > (rule.maxLength ?? Infinity) || (rule.pattern && !new RegExp(rule.pattern).test(value)))) fail(`schema-mismatch:${location}`);
  if (rule.type === 'boolean' && typeof value !== 'boolean') fail(`schema-mismatch:${location}`);
  if (rule.type === 'integer' && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (rule.minimum ?? -Infinity) || value > (rule.maximum ?? Infinity))) fail(`schema-mismatch:${location}`);
  if (rule.type === 'object') {
    const properties = rule.properties ?? {};
    if (!record(value) || (rule.required ?? []).some((key) => !Object.hasOwn(value, key))
      || (rule.additionalProperties === false && Object.keys(value).some((key) => !Object.hasOwn(properties, key)))) fail(`schema-mismatch:${location}`);
    for (const [key, field] of Object.entries(properties)) if (Object.hasOwn(value, key)) validate(value[key], field, `${location}.${key}`);
  }
  if (rule.type === 'array') {
    if (!Array.isArray(value) || value.length < (rule.minItems ?? 0) || value.length > (rule.maxItems ?? Infinity) || !rule.items) fail(`schema-mismatch:${location}`);
    const entries: unknown[] = value;
    const itemRule = rule.items;
    entries.forEach((item, index) => validate(item, itemRule, `${location}[${index}]`));
  }
};
export const validateEvidence = <K extends keyof EvidenceTypesType>(type: K, value: unknown): EvidenceTypesType[K] => {
  const rule = evidenceSchema.$defs[type];
  if (!rule) fail('schema-type-unknown');
  validate(value, rule, type);
  // The assertion is confined to this schema-validated boundary; callers never cast unverified JSON.
  return value as EvidenceTypesType[K];
};
export const sortedAssets = (assets: unknown): AssetType[] => {
  const verified = validateEvidence('assets', assets);
  const sorted = [...verified].sort((a, b) => a.name.localeCompare(b.name, 'en'));
  if (new Set(sorted.map((asset) => asset.name)).size !== sorted.length) fail('asset-name-collision');
  return sorted;
};
export const assetDigest = (assets: unknown): string => sha256(Buffer.from(JSON.stringify(sortedAssets(assets).map(({ name, sha256: digest, size }) => ({ name, sha256: digest, size })))));
export const identityFromAuthority = (authority: Record<string, unknown>, repository: string): ReleaseIdentityType => {
  const identity = validateEvidence('identity', authority.publication);
  if (identity.repository !== repository || identity.source_sha !== authority.source_sha
    || identity.version !== authority.version || identity.target_identity !== authority.target_identity) fail('authority-handoff-binding-mismatch');
  return identity;
};
export const readAuthority = (filename: string, repository: string): ReleaseIdentityType => identityFromAuthority(readRecord(filename), repository);
