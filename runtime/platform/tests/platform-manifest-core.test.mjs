import { test, describe, expect } from 'vitest';

import {
  PlatformManifestSemanticError,
  validatePlatformManifestValue,
} from '../platform-manifest-core.mjs';

const platform = (overrides = {}) => ({
  id: 'linux-x64',
  runner: 'ubuntu-24.04',
  target: 'x86_64-unknown-linux-gnu',
  ...overrides,
});

describe("platform-manifest-core", () => {
  for (const [label, entry, code] of [
    ['invalid ID syntax', platform({ id: 'INVALID' }), 'platform-id-invalid'],
    ['target path traversal', platform({ target: '../escape' }), 'platform-target-invalid'],
  ]) {
    // evidence_role: supplemental
    // test_level: unit
    // target_id: validatePlatformManifestValue(manifest)
    // These syntax boundaries supplement the Action's shape, duplicate and runner cases.
    test(`platform manifest core reports a typed failure for ${label}`, () => {
      // Arrange
      const manifest = { platforms: [entry] };
      let failure;
      // Act
      try { validatePlatformManifestValue(manifest); } catch (error) { failure = error; }
      // Assert
      expect(failure instanceof PlatformManifestSemanticError).toBeTruthy();
      expect(failure.code).toBe(code);
      expect(failure.index).toBe(0);
    });
  }
});
