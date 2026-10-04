import fs from 'node:fs';
import path from 'node:path';
import { describe, test, expect } from 'vitest';

describe('ci-release-supplemental-asset Action contract', () => {
  test('supplemental Action declares the bound v2 invocation inputs and node24 bundle', () => {
    const action = fs.readFileSync(path.resolve(__dirname, '../action.yml'), 'utf8');
    for (const name of ['operation', 'source-root', 'authority-path', 'snapshot-path', 'standard-build-root', 'supplemental-build-root', 'output-directory']) {
      expect(action).toMatch(new RegExp(`^  ${name}:$`, 'm'));
    }
    expect(action).toMatch(/using: node24/);
    expect(action).toMatch(/main: dist\/index\.js/);
    expect(action).not.toMatch(/token:|owner-adapter:/);
    expect(fs.existsSync(path.resolve(__dirname, '../dist/index.js'))).toBeTruthy();
  });
});
