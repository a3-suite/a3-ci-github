export const ownerDescriptor = () => ({
  schemaVersion: '1', kind: 'ci-adapter-bundle', id: 'owner-quality', contract: 'quality-scripts',
  languageProfiles: ['owner-profile'], provider: 'provider-neutral', executionBoundary: 'read-only',
  sourceCheckout: 'fixed-source', copyable: true, owner: 'project',
  assets: [{ destination: '.ci/scripts/owner-quality.mjs' }],
  projectSettings: { requiredFiles: ['package.json'], requiredScripts: ['quality'], requiredEnvironmentPaths: ['CI_OWNER_CONFIG'] },
  toolchain: { versionEnv: 'CI_TOOLCHAIN_VERSION', verify: { id: 'version', command: 'node', args: ['--version'] } },
  preparation: [{ id: 'prepare', command: 'node' }], commands: [{ id: 'quality', command: 'node' }],
});
