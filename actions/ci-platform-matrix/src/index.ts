import fs from 'node:fs';
import { MAX_MANIFEST_BYTES, resolvePlatformMatrix } from './matrix.js';

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
    fs.appendFileSync(outputPath, `matrix=${JSON.stringify(matrix)}\n`, 'utf8');
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
};

if (process.env.GITHUB_ACTIONS === 'true') run();
