export const PLATFORM_RUNNERS = Object.freeze(['ubuntu-24.04', 'macos-14', 'windows-2022']);

const PLATFORM_ID = /^[a-z0-9][a-z0-9-]*$/;
const TARGET = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const ALLOWED_RUNNERS = new Set(PLATFORM_RUNNERS);
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

export class PlatformManifestSemanticError extends Error {
  constructor(code, message, index = undefined) {
    super(message);
    this.name = 'PlatformManifestSemanticError';
    this.code = code;
    this.index = index;
  }
}

export const validatePlatformManifestValue = (manifest) => {
  if (!isRecord(manifest) || Object.keys(manifest).join(',') !== 'platforms') {
    throw new PlatformManifestSemanticError(
      'root-invalid',
      'platform manifest must contain only a platforms list',
    );
  }
  if (!Array.isArray(manifest.platforms) || manifest.platforms.length === 0) {
    throw new PlatformManifestSemanticError(
      'platforms-empty',
      'platform manifest must contain at least one platform',
    );
  }

  const ids = new Set();
  const targets = new Set();
  return manifest.platforms.map((value, index) => {
    if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'id,runner,target') {
      throw new PlatformManifestSemanticError(
        'platform-shape-invalid',
        `platforms[${index}] must contain id, runner, and target`,
        index,
      );
    }
    const { id, runner, target } = value;
    if (typeof id !== 'string' || !PLATFORM_ID.test(id) || ids.has(id)) {
      throw new PlatformManifestSemanticError(
        'platform-id-invalid',
        `platforms[${index}].id is invalid or duplicated`,
        index,
      );
    }
    if (typeof runner !== 'string' || !ALLOWED_RUNNERS.has(runner)) {
      throw new PlatformManifestSemanticError(
        'platform-runner-invalid',
        `platforms[${index}].runner is not allowed`,
        index,
      );
    }
    if (typeof target !== 'string' || !TARGET.test(target) || targets.has(target)) {
      throw new PlatformManifestSemanticError(
        'platform-target-invalid',
        `platforms[${index}].target is invalid or duplicated`,
        index,
      );
    }
    ids.add(id);
    targets.add(target);
    return { id, runner, target };
  });
};
