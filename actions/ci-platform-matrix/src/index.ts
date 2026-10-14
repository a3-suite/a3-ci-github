import { completeFailure, FailureContext, safeErrorReason, DiagnosticError } from '../../../runtime/diagnostics/failure.mjs';
import fs from 'node:fs';
import { MAX_MANIFEST_BYTES, resolvePlatformMatrix, resolveQualityMatrix } from './matrix.js';

const readManifest = (manifestPath: string): string => {
  if (!manifestPath || /[\0\r\n]/.test(manifestPath)) {
    throw new DiagnosticError('platform-matrix-manifest-path-invalid');
  }
  const stat = fs.statSync(manifestPath);
  if (!stat.isFile()) throw new DiagnosticError('platform-matrix-manifest-not-file');
  if (stat.size > MAX_MANIFEST_BYTES) throw new DiagnosticError('platform-matrix-manifest-too-large');
  return fs.readFileSync(manifestPath, 'utf8');
};

export const run = (): void => {
  const diagnostic = new FailureContext('ci-platform-matrix', 'platform-matrix');
  try {
    const manifestPath = process.env['INPUT_MANIFEST-PATH'] ?? '';
    const outputPath = process.env.GITHUB_OUTPUT ?? '';
    if (!outputPath || /[\0\r\n]/.test(outputPath)) {
      throw new DiagnosticError('platform-matrix-output-path-invalid');
    }
    diagnostic.confirmed();
    diagnostic.at('manifest-validation', {"input": "manifest-path"});
    const runnerPolicy = process.env['INPUT_RUNNER-POLICY'] || 'bootstrap';
    if (runnerPolicy !== 'bootstrap' && runnerPolicy !== 'trusted') {
      throw new DiagnosticError('platform-matrix-runner-policy-invalid');
    }
    const matrix = resolvePlatformMatrix(readManifest(manifestPath), runnerPolicy);
    const selectionPath = process.env['INPUT_SELECTION-PATH'] ?? '';
    let outputs = `matrix=${JSON.stringify(matrix)}\n`;
    if (selectionPath !== '') {
      if (/[\0\r\n]/.test(selectionPath)) throw new DiagnosticError('platform-matrix-selection-path-invalid');
      if (!fs.statSync(selectionPath).isFile()) throw new DiagnosticError('platform-matrix-selection-not-file');
    diagnostic.confirmed();
    diagnostic.at('selection-validation', {"input": "selection-path"});
      const quality = resolveQualityMatrix(matrix, fs.readFileSync(selectionPath, 'utf8'));
      outputs += `quality-matrix=${JSON.stringify(quality.matrix)}\nexpected-platforms=${quality.expectedPlatforms}\n`;
    }
    diagnostic.confirmed();
    diagnostic.at('output-write', {"output": "GITHUB_OUTPUT"});
    diagnostic.writeState = 'write-may-be-partial';
    fs.appendFileSync(outputPath, outputs, 'utf8');
  } catch (error) {
    diagnostic.report(error);
    completeFailure(safeErrorReason(error), 1);
  }
};

if (process.env.GITHUB_ACTIONS === 'true') run();
