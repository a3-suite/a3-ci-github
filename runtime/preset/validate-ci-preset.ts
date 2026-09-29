#!/usr/bin/env -S node --import tsx
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseFlagArguments } from './cli-args.ts';
import { validateCiPreset } from './validate-ci-preset-core.ts';
export {
  canonicalSourcePath,
  collectProviderStaticValidationConfigPaths,
  isSafeProviderConfigPath,
} from './ci-preset-assets.ts';

export { validateCiPreset };

const parseArgs = (argv: string[]): {
  repoRoot: string;
  skillCollectionRoot?: string;
  presets: string[];
  output?: string;
} => {
  const result: {
    repoRoot: string;
    skillCollectionRoot?: string;
    presets: string[];
    output?: string;
  } = { repoRoot: '.', presets: [] };
  parseFlagArguments(argv, {
    '--repo-root': (value) => { result.repoRoot = value; },
    '--skill-collection-root': (value) => { result.skillCollectionRoot = value; },
    '--preset': (value) => { result.presets.push(value); },
    '--output': (value) => { result.output = value; },
  });
  return result;
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = validateCiPreset(options);
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (options.output) fs.writeFileSync(options.output, output);
    else process.stdout.write(output);
    process.exitCode = report.status === 'success' ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
