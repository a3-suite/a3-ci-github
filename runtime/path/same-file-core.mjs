import fs from 'node:fs';
import path from 'node:path';

const canonicalPath = (value, invalidCode) => {
  const absolute = path.resolve(value);
  const suffix = [];
  let current = absolute;
  while (true) {
    try {
      return path.join(fs.realpathSync.native(current), ...suffix);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
        throw new Error(invalidCode);
      }
      const parent = path.dirname(current);
      if (parent === current) throw new Error(invalidCode);
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
};

export const pathsReferToSameFile = (left, right, invalidCode) => {
  if (typeof invalidCode !== 'string' || invalidCode.length === 0) {
    throw new Error('same-file-invalid-code');
  }
  if (canonicalPath(left, invalidCode) === canonicalPath(right, invalidCode)) return true;
  try {
    const leftStat = fs.statSync(left);
    const rightStat = fs.statSync(right);
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw new Error(invalidCode);
  }
};
