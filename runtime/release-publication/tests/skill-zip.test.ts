import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import { createSkillZip } from '../skill-zip';

describe('skill ZIP file count', () => {
  // integration_id: skill-zip-file-count
  test.each([65534, 65535, 65536])('standard ZIP readers accept %i files', count => {
    const entries = Array.from({ length: count }, (_, index) => ({
      name: `tool/assets/${index}.txt`, bytes: Buffer.alloc(0), mode: 0o100644,
    }));
    const archive = createSkillZip(entries);
    const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c',
      'import io,sys,zipfile; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); assert z.testzip() is None; print(len(z.infolist()))'],
    { input: archive, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(Number(result.stdout.trim())).toBe(count);
  });
});
