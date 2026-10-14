import path from 'node:path';
import { createRequire } from 'node:module';
import { execFile, type ExecFileOptions, type ExecFileException } from 'node:child_process';

type EntrypointResult = {
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  error: ExecFileException | null;
};

export const runActionEntrypoint = (args: string[], options: ExecFileOptions = {}): Promise<EntrypointResult> =>
  new Promise((resolve) => {
    execFile(process.execPath, args, { timeout: 30000, maxBuffer: 1024 * 1024, ...options, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ status: error ? typeof error.code === 'number' ? error.code : null : 0,
        signal: error?.signal ?? null, stdout, stderr, error });
    });
  });

export const actionEntrypointArguments = (actionRoot: string, surface: 'source' | 'dist'): string[] => {
  if (surface === 'dist') return [path.join(actionRoot, 'dist/index.js')];
  const require = createRequire(path.join(actionRoot, 'package.json'));
  return ['--import', require.resolve('tsx'), path.join(actionRoot, 'src/index.ts')];
};
