import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { validatePlatformManifestValue } from '../../platform/platform-manifest-core.mjs';
import { sourceTextSha256 } from '../../platform/source-text.mjs';

export const verifyPlatformSelection = (manifestText, selectedId, selectedTarget) => {
  const manifest = parse(manifestText);
  const platforms = validatePlatformManifestValue(manifest);
  const selected = platforms.find((platform) => platform.id === selectedId) ?? null;

  if (selected === null) throw new Error('selected platform id is not present in the manifest');
  if (selected.target !== selectedTarget) throw new Error('selected platform target does not match the manifest');
};

const main = () => {
  const [manifestPath, selectedId, selectedTarget, expectedDigest, ...extra] = process.argv.slice(2);
  if (!manifestPath || !selectedId || !selectedTarget || !/^[a-f0-9]{64}$/.test(expectedDigest ?? '') || extra.length) {
    throw new Error('usage: verify-platform-manifest.js <manifest> <platform-id> <platform-target> <source-text-sha256>');
  }
  const bytes = fs.readFileSync(manifestPath);
  if (sourceTextSha256(bytes) !== expectedDigest) throw new Error('platform manifest identity mismatch');
  verifyPlatformSelection(bytes.toString('utf8'), selectedId, selectedTarget);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
