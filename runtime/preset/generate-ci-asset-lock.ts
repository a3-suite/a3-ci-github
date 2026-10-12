#!/usr/bin/env -S node --import tsx
import { completeFailure, FailureContext, safeErrorReason } from '../diagnostics/failure.mjs';

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
  const diagnostic = new FailureContext('ci-preset-assurance', 'lock');
  try {
    const options = parseArgs(process.argv.slice(2));
    diagnostic.confirmed();
    diagnostic.at('lock-generation', { input: 'workflows-registry-and-source-revision' });
    diagnostic.writeState = 'lock-write-may-have-started';
    const lock = writeCiAssetLock(options);
    process.stdout.write(`${JSON.stringify(lock, null, 2)}\n`);
  } catch (error) {
    diagnostic.report(error);
    completeFailure(safeErrorReason(error), 2);
  }
}
