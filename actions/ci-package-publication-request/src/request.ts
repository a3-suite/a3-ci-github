import fs from 'node:fs';
import path from 'node:path';

export type RequestFields = {
  sourceSha: string;
  version: string;
  targetIdentity: string;
  languageProfile: string;
  toolchain: string;
};

const SHA = /^[a-f0-9]{40}$/;
const scalar = (value: string, field: string): string => {
  if (!value || /[\0\r\n]/.test(value)) throw new Error(`package-publication-${field}-invalid`);
  return value;
};

const validate = (fields: RequestFields): RequestFields => {
  if (!SHA.test(fields.sourceSha)) throw new Error('package-publication-source-sha-invalid');
  return {
    sourceSha: fields.sourceSha,
    version: scalar(fields.version, 'version'),
    targetIdentity: scalar(fields.targetIdentity, 'target-identity'),
    languageProfile: scalar(fields.languageProfile, 'language-profile'),
    toolchain: scalar(fields.toolchain, 'toolchain'),
  };
};

export const createRequest = (requestPath: string, fields: RequestFields): RequestFields => {
  const value = validate(fields);
  fs.mkdirSync(path.dirname(requestPath), { recursive: true });
  fs.writeFileSync(requestPath, `${JSON.stringify({ schema: 'ci.package-publication-request.v1', ...value })}\n`, 'utf8');
  return value;
};

export const verifyRequest = (requestPath: string, expectedSourceSha: string): RequestFields => {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
  } catch {
    throw new Error('package-publication-request-unreadable');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('package-publication-request-schema-invalid');
  const record = value as Record<string, unknown>;
  const fields = validate({
    sourceSha: typeof record.sourceSha === 'string' ? record.sourceSha : '',
    version: typeof record.version === 'string' ? record.version : '',
    targetIdentity: typeof record.targetIdentity === 'string' ? record.targetIdentity : '',
    languageProfile: typeof record.languageProfile === 'string' ? record.languageProfile : '',
    toolchain: typeof record.toolchain === 'string' ? record.toolchain : '',
  });
  if (record.schema !== 'ci.package-publication-request.v1') throw new Error('package-publication-request-schema-invalid');
  if (!SHA.test(expectedSourceSha) || fields.sourceSha !== expectedSourceSha) throw new Error('package-publication-source-sha-mismatch');
  return fields;
};
