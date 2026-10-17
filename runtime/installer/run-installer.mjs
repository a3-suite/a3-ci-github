#!/usr/bin/env node
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

let installer;
try {
  installer = createRequire(import.meta.url)('./dist/index.js');
  installer.runInstallerCli(process.argv.slice(2), fileURLToPath(new URL('./', import.meta.url)));
} catch (error) {
  process.exitCode = 1;
  try { process.stderr.write(`${installer?.installerErrorMessage?.(error) ?? 'installer-failed'}\n`); } catch { /* Preserve the installer result if the final sink fails. */ }
}
