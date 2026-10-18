import { accessSync, constants, readFileSync } from 'node:fs';
import path from 'node:path';
import { test, describe, expect } from 'vitest';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const action = readFileSync(path.join(root, 'action.yml'), 'utf8');
const script = path.resolve(root, '../../runtime/github-toolchain/verify-github-toolchain.sh');

describe("ci-github-toolchain-verifier action contract", () => {
  describe("ci-github-toolchain-verifier-action-regression", () => {
    // integration_id: ci-github-toolchain-verifier-action-regression
    test('action.yml exposes a thin composite contract for the shared script', () => {
      // Arrange
      const actionPath = path.join(root, 'action.yml');
      // Act
      const action = readFileSync(actionPath, 'utf8');
      // Assert
      expect(action).toMatch(/^name: ci-github-toolchain-verifier$/m);
      expect(action).toMatch(/^  using: composite$/m);
      for (const input of ['mode', 'gh-version', 'jq-version', 'sha256sum-version']) {
        expect(action).toMatch(new RegExp(`^  ${input}:$`, 'm'));
      }
      expect(action).toMatch(/^  verified:$/m);
      expect(action).toMatch(/^    value: \$\{\{ steps\.verify\.outputs\.verified \}\}$/m);
      expect(action).toMatch(/runtime\/github-toolchain\/verify-github-toolchain\.sh/);
      expect(action).toMatch(/^        VERIFY_MODE: \$\{\{ inputs\.mode \}\}$/m);
      expect(action).toMatch(/verify-github-toolchain\.sh\" \"\$VERIFY_MODE\"/);
      accessSync(script, constants.R_OK | constants.X_OK);
    });
  });
});
