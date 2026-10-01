import path from 'node:path';
import { createRequire } from 'node:module';
import { validatePlatformManifestValue } from '../platform/platform-manifest-core.mjs';
import type { Platform } from '../platform/platform-manifest-core.mjs';

const runtimeRoot = process.env.CI_GITHUB_PREFLIGHT_RUNTIME_ROOT;
const require = runtimeRoot
  ? createRequire(path.resolve(runtimeRoot, 'package.json'))
  : createRequire(import.meta.url);
const yaml = require(runtimeRoot ? path.join(path.resolve(runtimeRoot), 'node_modules', 'yaml') : 'yaml') as {
  parse(text: string, options?: object): unknown;
};

const MAX_MANIFEST_BYTES = 64 * 1024;

export const validatePlatformManifest = (manifestText: string): Platform[] => {
  if (Buffer.byteLength(manifestText, 'utf8') > MAX_MANIFEST_BYTES) {
    throw new Error('platform manifest exceeds 64 KiB');
  }
  const manifest = yaml.parse(manifestText, { maxAliasCount: 20, uniqueKeys: true });
  return validatePlatformManifestValue(manifest);
};
