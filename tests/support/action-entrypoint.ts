import path from 'node:path';
import { createRequire } from 'node:module';

export const actionEntrypointArguments = (actionRoot: string, surface: 'source' | 'dist'): string[] => {
  if (surface === 'dist') return [path.join(actionRoot, 'dist/index.js')];
  const require = createRequire(path.join(actionRoot, 'package.json'));
  return ['--import', require.resolve('tsx'), path.join(actionRoot, 'src/index.ts')];
};
