export type SupplementalSelectionType = { implementation: 'owner-adapter' | 'standard-installer'; configPath?: string };

/** Resolve only authority snapshot values; never infer an implementation from files. */
export const supplementalSelection = (values: Record<string, unknown>): SupplementalSelectionType => {
  const implementation = values.CI_SUPPLEMENTAL_RELEASE_ASSET_IMPLEMENTATION ?? 'owner-adapter';
  const configuredPath = values.CI_SUPPLEMENTAL_RELEASE_ASSET_CONFIG_PATH;
  const configPath = configuredPath === undefined || configuredPath === '__unset__' || configuredPath === '' ? undefined : configuredPath;
  if (implementation !== 'owner-adapter' && implementation !== 'standard-installer') throw new Error('supplemental-implementation-invalid');
  if (implementation === 'owner-adapter') {
    if (configPath !== undefined) throw new Error('supplemental-config-unexpected');
    return { implementation };
  }
  if (values.CI_SUPPLEMENTAL_RELEASE_ASSET_ENABLED !== 'true') throw new Error('standard-installer-disabled');
  if (values.CI_SUPPLEMENTAL_RELEASE_ASSET_OWNER_CONTRACT !== 'installer.asset-assembly-evidence-contract') throw new Error('installer-owner-contract-invalid');
  if (typeof configPath !== 'string' || !configPath || /[\0\r\n]/.test(configPath)) throw new Error('installer-config-required');
  return { implementation, configPath };
};
