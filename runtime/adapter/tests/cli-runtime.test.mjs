import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { isDirectExecution } from '../cli-runtime.ts';

test('direct execution resolves symlinked entrypoints to the same real path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a3-cli-runtime-'));
  try {
    const target = path.join(root, 'entry.ts');
    const link = path.join(root, 'entry-link.ts');
    fs.writeFileSync(target, 'export {};\n');
    fs.symlinkSync(target, link);
    assert.equal(
      isDirectExecution(pathToFileURL(target).href, [process.execPath, link]),
      true,
    );
    assert.equal(
      isDirectExecution(
        pathToFileURL(path.join(root, 'other.ts')).href,
        [process.execPath, link],
      ),
      false,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
