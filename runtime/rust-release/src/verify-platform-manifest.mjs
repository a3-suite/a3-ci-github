import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { validatePlatformManifestValue } from '../../platform/platform-manifest-core.mjs';

export const verifyPlatformSelection = (manifestText, selectedId, selectedTarget) => {
  const manifest = parse(manifestText);
  const platforms = validatePlatformManifestValue(manifest);
  const selected = platforms.find((platform) => platform.id === selectedId) ?? null;

  if (selected === null) throw new Error('selected platform id is not present in the manifest');
  if (selected.target !== selectedTarget) throw new Error('selected platform target does not match the manifest');
};

const main = () => {
  const [manifestPath, selectedId, selectedTarget] = process.argv.slice(2);
  if (!manifestPath || !selectedId || !selectedTarget) {
    throw new Error('usage: verify-platform-manifest.js <manifest> <platform-id> <platform-target>');
  }
  verifyPlatformSelection(fs.readFileSync(manifestPath, 'utf8'), selectedId, selectedTarget);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
