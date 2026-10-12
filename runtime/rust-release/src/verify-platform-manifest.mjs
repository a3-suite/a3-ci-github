import { DiagnosticError, FailureContext, safeErrorReason } from '../../diagnostics/failure.mjs';
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

  if (selected === null) throw new DiagnosticError('platform-selection-id-missing', { diagnostics: { field: 'platform-id', expected: 'declared-id', observed: 'unknown-id' } });
  if (selected.target !== selectedTarget) throw new DiagnosticError('platform-selection-target-mismatch', { diagnostics: { field: 'platform-target', expected: selected.target, observed: 'unbound-target' } });
};

const main = () => {
  const [manifestPath, selectedId, selectedTarget, expectedDigest, ...extra] = process.argv.slice(2);
  if (!manifestPath || !selectedId || !selectedTarget || !/^[a-f0-9]{64}$/.test(expectedDigest ?? '') || extra.length) {
    throw new DiagnosticError('platform-selection-arguments-invalid');
  }
  const bytes = fs.readFileSync(manifestPath);
  if (sourceTextSha256(bytes) !== expectedDigest) throw new DiagnosticError('platform-manifest-identity-mismatch', { diagnostics: { field: 'platform-manifest-sha256', expected: expectedDigest, observed: sourceTextSha256(bytes) } });
  verifyPlatformSelection(bytes.toString('utf8'), selectedId, selectedTarget);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const diagnostic = new FailureContext('ci-rust-release-build', 'platform-verification');
  diagnostic.at('platform-binding', { input: 'platform-manifest-and-selection' });
  try { main(); }
  catch (error) {
    diagnostic.report(error);
    console.error(safeErrorReason(error));
    process.exitCode = 1;
  }
}
