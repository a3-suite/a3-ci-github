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
  // evidence_role: supplemental
  // test_level: unit
  // target_id: validatePlatformManifestValue(manifest, runnerPolicy)
  test.each(['macos-15', 'windows-2025', 'ubuntu-22.04', 'ubuntu-24.04-arm', 'macos-15-intel'])('trusted manifest accepts the consumer-selected versioned runner %s', (runner) => {
    expect(validatePlatformManifestValue({ platforms: [platform({ runner })] }, 'trusted'))
      .toStrictEqual([platform({ runner })]);
    expect(() => validatePlatformManifestValue({ platforms: [platform({ runner })] }))
      .toThrow('runner is not allowed');
  });

  // evidence_role: supplemental
  // test_level: unit
  // target_id: validatePlatformManifestValue(manifest, runnerPolicy)
  test.each(['self-hosted', 'macos-latest', 'ubuntu-latest', 'windows-latest', 'macos-15\n', '${{ github.event.runner }}', 'custom-runner'])('trusted manifest rejects unsafe or unversioned runner %s', (runner) => {
    expect(() => validatePlatformManifestValue({ platforms: [platform({ runner })] }, 'trusted'))
      .toThrow('runner is not allowed');
  });

  // evidence_role: supplemental
  // test_level: unit
  // target_id: validatePlatformManifestValue(manifest, runnerPolicy)
  test('unknown runner policy fails closed', () => {
    expect(() => validatePlatformManifestValue({ platforms: [platform()] }, 'unknown'))
      .toThrow('runner policy is invalid');
  });

  for (const [label, entry, code] of [
    ['invalid ID syntax', platform({ id: 'INVALID' }), 'platform-id-invalid'],
    ['target path traversal', platform({ target: '../escape' }), 'platform-target-invalid'],
  ]) {
    // evidence_role: supplemental
    // test_level: unit
    // target_id: validatePlatformManifestValue(manifest, runnerPolicy)
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
