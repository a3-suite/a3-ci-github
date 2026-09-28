#!/usr/bin/env -S node --import tsx

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { writeCiAssetLock } from './validate-ci-preset.ts';

const parseArgs = (argv: string[]): {
  repoRoot: string;
  skillCollectionRoot: string;
  sourceRevision: string;
} => {
  const result = { repoRoot: '.', skillCollectionRoot: '', sourceRevision: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
    if (flag === '--repo-root') result.repoRoot = value;
    else if (flag === '--skill-collection-root') result.skillCollectionRoot = value;
    else if (flag === '--source-revision') result.sourceRevision = value;
    else throw new Error(`unknown argument: ${flag}`);
    index += 1;
  }
  if (!result.skillCollectionRoot) throw new Error('--skill-collection-root is required');
  return result;
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const lock = writeCiAssetLock(options);
    process.stdout.write(`${JSON.stringify(lock, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
