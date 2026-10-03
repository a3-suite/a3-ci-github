#!/usr/bin/env -S node --import tsx

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { writeCiAssetLock } from './ci-asset-lock-plan.ts';
import { parseFlagArguments } from './cli-args.ts';

const parseArgs = (argv: string[]): {
  repoRoot: string;
  skillCollectionRoot?: string;
  sourceRevision: string;
} => {
  const result: { repoRoot: string; skillCollectionRoot?: string; sourceRevision: string } = {
    repoRoot: '.', sourceRevision: '',
  };
  parseFlagArguments(argv, {
    '--repo-root': (value) => { result.repoRoot = value; },
    '--skill-collection-root': (value) => { result.skillCollectionRoot = value; },
    '--source-revision': (value) => { result.sourceRevision = value; },
  });
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
