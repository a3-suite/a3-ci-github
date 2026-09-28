import assert from 'node:assert/strict';
import test from 'node:test';

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

// target_id: validatePlatformManifestValue
test('platform manifest core returns a validated platform list', () => {
  // Arrange
  const manifest = { platforms: [platform()] };
  // Act
  const result = validatePlatformManifestValue(manifest);
  // Assert
  assert.deepEqual(result, [platform()]);
});

// target_id: validatePlatformManifestValue
test('platform manifest core rejects shape runner and identity drift', () => {
  const cases = [
    [{ unexpected: [] }, 'root-invalid'],
    [{ platforms: [] }, 'platforms-empty'],
    [{ platforms: [{ ...platform(), extra: true }] }, 'platform-shape-invalid'],
    [{ platforms: [platform({ id: 'INVALID' })] }, 'platform-id-invalid'],
    [{ platforms: [platform({ runner: 'ubuntu-latest' })] }, 'platform-runner-invalid'],
    [{ platforms: [platform({ target: '../escape' })] }, 'platform-target-invalid'],
    [{ platforms: [platform(), platform({ target: 'other-target' })] }, 'platform-id-invalid'],
    [{ platforms: [platform(), platform({ id: 'other' })] }, 'platform-target-invalid'],
  ];
  // Arrange
  for (const [manifest, expectedCode] of cases) {
    let failure;
    // Act
    try { validatePlatformManifestValue(manifest); } catch (error) { failure = error; }
    // Assert
    assert.ok(failure instanceof PlatformManifestSemanticError);
    assert.equal(failure.code, expectedCode);
  }
});
