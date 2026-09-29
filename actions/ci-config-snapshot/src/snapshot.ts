import crypto from 'node:crypto';

type ConfigValues = Record<string, string>;
type ConfigSources = { runtime?: ConfigValues; workflow?: ConfigValues; preset?: ConfigValues };

export type ConfigSnapshot = {
  schema: 'ci.config-snapshot.v1';
  values: ConfigValues;
  sources: Record<string, keyof ConfigSources>;
  digest: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseValues = (value: unknown, source: string): ConfigValues => {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`config-snapshot-${source}-invalid`);
  const values: ConfigValues = Object.create(null) as ConfigValues;
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) throw new Error('config-snapshot-key-invalid');
    if (typeof entry !== 'string' || entry.length === 0 || /[\0\r\n]/.test(entry)) {
      throw new Error(`config-snapshot-${source}-value-invalid`);
    }
    values[key] = entry;
  }
  return values;
};

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

export const resolveConfigSnapshot = (input: unknown): ConfigSnapshot => {
  if (!isRecord(input)) throw new Error('config-snapshot-input-invalid');
  const sources: Record<string, keyof ConfigSources> = Object.create(null) as Record<string, keyof ConfigSources>;
  const values: ConfigValues = Object.create(null) as ConfigValues;
  for (const [source, sourceValues] of [
    ['runtime', parseValues(input.runtime, 'runtime')],
    ['workflow', parseValues(input.workflow, 'workflow')],
    ['preset', parseValues(input.preset, 'preset')],
  ] as const) {
    for (const [key, value] of Object.entries(sourceValues)) {
      if (sources[key] === undefined) {
        values[key] = value;
        sources[key] = source;
      }
    }
  }
  const digest = crypto.createHash('sha256').update(stableJson({ sources, values }), 'utf8').digest('hex');
  return { schema: 'ci.config-snapshot.v1', values, sources, digest };
};
