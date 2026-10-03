import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';

test('supplemental Action declares the bound v2 invocation inputs and node24 bundle', () => {
  const action = fs.readFileSync(path.resolve(__dirname, '../action.yml'), 'utf8');
  for (const name of ['operation', 'source-root', 'authority-path', 'snapshot-path', 'standard-build-root', 'supplemental-build-root', 'output-directory']) {
    assert.match(action, new RegExp(`^  ${name}:$`, 'm'));
  }
  assert.match(action, /using: node24/);
  assert.match(action, /main: dist\/index\.js/);
  assert.doesNotMatch(action, /token:|owner-adapter:/);
  assert.ok(fs.existsSync(path.resolve(__dirname, '../dist/index.js')));
});
