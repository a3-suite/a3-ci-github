import fs from 'node:fs';
import path from 'node:path';

const canonicalPath = (value: string): string => {
  const absolute = path.resolve(value);
  const suffix: string[] = [];
  let current = absolute;
  while (true) {
    try {
      const resolved = fs.realpathSync.native(current);
      return path.join(resolved, ...suffix);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
        throw new Error('config-snapshot-path-invalid');
      }
      const parent = path.dirname(current);
      if (parent === current) throw new Error('config-snapshot-path-invalid');
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
};

export const pathsReferToSameFile = (left: string, right: string): boolean => {
  if (canonicalPath(left) === canonicalPath(right)) return true;
  try {
    const leftStat = fs.statSync(left);
    const rightStat = fs.statSync(right);
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw new Error('config-snapshot-path-invalid');
  }
};
