import fs from 'node:fs';
import { MAX_MANIFEST_BYTES, resolvePlatformMatrix, resolveQualityMatrix } from './matrix.js';

const readManifest = (manifestPath: string): string => {
  if (!manifestPath || /[\0\r\n]/.test(manifestPath)) {
    throw new Error('platform-matrix-manifest-path-invalid');
  }
  const stat = fs.statSync(manifestPath);
  if (!stat.isFile()) throw new Error('platform-matrix-manifest-not-file');
  if (stat.size > MAX_MANIFEST_BYTES) throw new Error('platform-matrix-manifest-too-large');
  return fs.readFileSync(manifestPath, 'utf8');
};

export const run = (): void => {
  try {
    const manifestPath = process.env['INPUT_MANIFEST-PATH'] ?? '';
    const outputPath = process.env.GITHUB_OUTPUT ?? '';
    if (!outputPath || /[\0\r\n]/.test(outputPath)) {
      throw new Error('platform-matrix-output-path-invalid');
    }
    const matrix = resolvePlatformMatrix(readManifest(manifestPath));
    const selectionPath = process.env['INPUT_SELECTION-PATH'] ?? '';
    let outputs = `matrix=${JSON.stringify(matrix)}\n`;
    if (selectionPath !== '') {
      if (/[\0\r\n]/.test(selectionPath)) throw new Error('platform-matrix-selection-path-invalid');
      if (!fs.statSync(selectionPath).isFile()) throw new Error('platform-matrix-selection-not-file');
      const quality = resolveQualityMatrix(matrix, fs.readFileSync(selectionPath, 'utf8'));
      outputs += `quality-matrix=${JSON.stringify(quality.matrix)}\nexpected-platforms=${quality.expectedPlatforms}\n`;
    }
    fs.appendFileSync(outputPath, outputs, 'utf8');
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
};

if (process.env.GITHUB_ACTIONS === 'true') run();
