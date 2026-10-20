import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, describe, expect } from 'vitest';
import { STANDARD_QUALITY_BUNDLES } from '../standard-quality-bundles.generated.ts';
import { generateStandardQualityBundles } from '../generate-standard-quality-bundles.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const inventory = 'skills/ci-github/assets/registry/ci-script-assets.yml';
const outputPath = 'runtime/adapter/standard-quality-bundles.generated.ts';
const fixture = (t) => {
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  const provider = fs.mkdtempSync(path.join(root, 'tmp/quality-generation-'));
  t.onTestFinished(() => fs.rmSync(provider, { recursive: true, force: true }));
  for (const file of [inventory, outputPath, ...STANDARD_QUALITY_BUNDLES.map(entry => entry.sourcePath)]) {
    fs.mkdirSync(path.dirname(path.join(provider, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(provider, file));
  }
  return provider;
};

export { root, inventory, outputPath, fixture };
