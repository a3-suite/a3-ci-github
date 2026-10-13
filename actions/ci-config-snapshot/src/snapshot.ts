import { DiagnosticError } from '../../../runtime/diagnostics/failure.mjs';
import crypto from 'node:crypto';
import { supplementalSelection, releaseSkillsConfigPath } from '../../../runtime/release-publication/selection';

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
  if (!isRecord(value)) throw new DiagnosticError(`config-snapshot-${source}-invalid`, { diagnostics: { stage: 'source-shape-validation', source, field: source, expected: 'setting-object', observed: typeof value } });
  const values: ConfigValues = Object.create(null) as ConfigValues;
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) throw new DiagnosticError('config-snapshot-key-invalid', { diagnostics: { stage: 'key-validation', source, field: 'setting-key', expected: 'identifier', observed: 'invalid-or-protected' } });
    if (typeof entry !== 'string' || entry.length === 0 || /[\0\r\n]/.test(entry)) {
      throw new DiagnosticError(`config-snapshot-${source}-value-invalid`, { diagnostics: { stage: 'value-validation', source, field: key, expected: 'nonempty-single-line-string', observed: typeof entry === 'string' ? 'invalid-or-protected' : typeof entry } });
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
  if (!isRecord(input)) throw new DiagnosticError('config-snapshot-input-invalid');
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
  supplementalSelection(values);
  releaseSkillsConfigPath(values);
  const digest = crypto.createHash('sha256').update(stableJson({ sources, values }), 'utf8').digest('hex');
  return { schema: 'ci.config-snapshot.v1', values, sources, digest };
};
