import { DiagnosticError } from '../diagnostics/failure.mjs';

export const releaseSkillsPath = (input: unknown): string => {
  if (typeof input !== 'string' || input.length === 0 || input.length > 512
    || !input.split('/').every(part => /^[A-Za-z0-9_.+-]+$/.test(part) && part !== '.' && part !== '..'
      && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) && !part.endsWith('.'))) {
    throw new DiagnosticError('skills-path-invalid');
  }
  return input;
};

export const releaseSkillsConfigPath = (values: Record<string, unknown>): string | undefined => {
  const value = values.CI_RELEASE_SKILLS_CONFIG_PATH;
  return value === undefined || value === '__unset__' ? undefined : releaseSkillsPath(value);
};

export type SupplementalSelectionType = { implementation: 'owner-adapter' | 'standard-installer'; configPath?: string };

/** Resolve only authority snapshot values; never infer an implementation from files. */
export const supplementalSelection = (values: Record<string, unknown>): SupplementalSelectionType => {
  const implementation = values.CI_SUPPLEMENTAL_RELEASE_ASSET_IMPLEMENTATION ?? 'owner-adapter';
  const configuredPath = values.CI_SUPPLEMENTAL_RELEASE_ASSET_CONFIG_PATH;
  const configPath = configuredPath === undefined || configuredPath === '__unset__' || configuredPath === '' ? undefined : configuredPath;
  if (implementation !== 'owner-adapter' && implementation !== 'standard-installer') throw new DiagnosticError('supplemental-implementation-invalid');
  if (implementation === 'owner-adapter') {
    if (configPath !== undefined) throw new DiagnosticError('supplemental-config-unexpected');
    return { implementation };
  }
  if (values.CI_SUPPLEMENTAL_RELEASE_ASSET_ENABLED !== 'true') throw new DiagnosticError('standard-installer-disabled');
  if (values.CI_SUPPLEMENTAL_RELEASE_ASSET_OWNER_CONTRACT !== 'installer.asset-assembly-evidence-contract') throw new DiagnosticError('installer-owner-contract-invalid');
  if (typeof configPath !== 'string' || !configPath || /[\0\r\n]/.test(configPath)) throw new DiagnosticError('installer-config-required');
  return { implementation, configPath };
};

const PLATFORM_FIELDS = ['language_profile', 'toolchain_version', 'platform_manifest', 'platform_manifest_sha256'];

/** An asset release is recognised only when the snapshot and authority both record no platform; any mixture is rejected. */
export const assetReleaseSelection = (values: Record<string, unknown>, authority: Record<string, unknown>): boolean => {
  const assetRelease = values.CI_RELEASE_IMPLEMENTATION === 'asset-release';
  if (assetRelease && (values.CI_PLATFORM_MANIFEST !== '__unset__' || PLATFORM_FIELDS.some((field) => authority[field] !== null))) throw new DiagnosticError('platform-mismatch');
  if (!assetRelease && authority.platform_manifest === null) throw new DiagnosticError('platform-mismatch');
  return assetRelease;
};
