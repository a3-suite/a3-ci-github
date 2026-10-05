#!/usr/bin/env node
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

try {
  createRequire(import.meta.url)('./dist/index.js').runInstallerCli(process.argv.slice(2), fileURLToPath(new URL('./dist/', import.meta.url)));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'installer-failed'}\n`);
  process.exitCode = 1;
}
