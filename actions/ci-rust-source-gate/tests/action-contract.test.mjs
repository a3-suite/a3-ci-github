import {
  accessSync,
  constants,
  readFileSync,
} from 'node:fs';
import path from 'node:path';
import { test, describe, expect } from 'vitest';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const action = readFileSync(path.join(root, 'action.yml'), 'utf8');
const script = path.resolve(root, '../../runtime/rust-release/ci-source-gate.sh');

describe("ci-rust-source-gate action contract", () => {
  describe("ci-rust-source-gate-action-regression", () => {
    // integration_id: ci-rust-source-gate-action-regression
    test('action.yml maps the public source gate inputs to the shared script', () => {
      // Arrange
      const actionPath = path.join(root, 'action.yml');
      // Act
      const action = readFileSync(actionPath, 'utf8');
      // Assert
      expect(action).toMatch(/^name: ci-rust-source-gate$/m);
      expect(action).toMatch(/^  using: composite$/m);
      for (const input of ['language-profile', 'authority-path']) {
        expect(action).toMatch(new RegExp(`^  ${input}:$`, 'm'));
      }
      expect(action).toMatch(/runtime\/rust-release\/ci-source-gate\.sh/);
      expect(action).toMatch(/^  verified:$/m);
      expect(action).toMatch(/^    value: \$\{\{ steps\.verify\.outputs\.verified \}\}$/m);
      expect(action).toMatch(/^        LANGUAGE_PROFILE: \$\{\{ inputs\.language-profile \}\}$/m);
      expect(action).toMatch(/^        AUTHORITY_PATH: \$\{\{ inputs\.authority-path \}\}$/m);
      accessSync(script, constants.R_OK | constants.X_OK);
    });
  });
});
