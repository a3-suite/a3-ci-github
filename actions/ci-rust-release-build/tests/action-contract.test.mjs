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
const scriptRoot = path.resolve(root, '../../runtime/rust-release');

describe("ci-rust-release-build action contract", () => {
  describe("ci-rust-release-build-action-regression", () => {
    // integration_id: ci-rust-release-build-action-regression
    test('action.yml maps release build inputs to the shared script family', () => {
      // Arrange
      const actionPath = path.join(root, 'action.yml');
      // Act
      const action = readFileSync(actionPath, 'utf8');
      // Assert
      expect(action).toMatch(/^name: ci-rust-release-build$/m);
      expect(action).toMatch(/^  using: composite$/m);
      for (const input of [
        'language-profile',
        'platform-manifest',
        'toolchain-version',
        'platform-id',
        'platform-target',
        'authority-path',
        'output-directory',
        'cargo-manifest-path',
        'release-binary-name',
        'release-asset-prefix',
      ]) {
        expect(action).toMatch(new RegExp(`^  ${input}:$`, 'm'));
      }
      expect(action).toMatch(/runtime\/rust-release\/ci-release-build\.sh/);
      expect(action).not.toMatch(/release-version-prefix/);
      expect(action).not.toMatch(/CI_RELEASE_VERSION_PREFIX/);
      expect(action).toMatch(/^  completed:$/m);
      expect(action).toMatch(/^    value: \$\{\{ steps\.build\.outputs\.completed \}\}$/m);
      expect(action).toMatch(/^        CI_CARGO_MANIFEST_PATH: \$\{\{ inputs\.cargo-manifest-path \}\}$/m);
      expect(action).toMatch(/^        CI_RELEASE_BINARY_NAME: \$\{\{ inputs\.release-binary-name \}\}$/m);
      for (const name of [
        'ci-release-build.sh',
        'ci-release-build.ps1',
        'package-release-unix.sh',
        'package-release.ps1',
        'verify-release-asset-unix.sh',
        'verify-release-asset.ps1',
        'dist/index.mjs',
      ]) {
        accessSync(path.join(scriptRoot, name), constants.R_OK);
      }
      for (const name of ['ci-release-build.sh', 'package-release-unix.sh', 'verify-release-asset-unix.sh']) {
        accessSync(path.join(scriptRoot, name), constants.X_OK);
      }
    });
  });
});
