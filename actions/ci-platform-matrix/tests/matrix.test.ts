import { strict as assert } from 'node:assert';
import test from 'node:test';
import { resolvePlatformMatrix } from '../src/matrix.js';

const validManifest = `platforms:
  - id: linux-x64
    runner: ubuntu-24.04
    target: x86_64-unknown-linux-gnu
  - id: macos-arm64
    runner: macos-14
    target: aarch64-apple-darwin
`;

const captureFailure = (operation: () => unknown): unknown => {
  try { operation(); } catch (error) { return error; }
  return undefined;
};

// target_id: resolvePlatformMatrix(string)
test('resolves a deterministic include matrix', () => {
  // Arrange
  const manifest = validManifest;

  // Act
  const result = resolvePlatformMatrix(manifest);

  // Assert
  assert.deepEqual(result, {
    include: [
      { id: 'linux-x64', runner: 'ubuntu-24.04', target: 'x86_64-unknown-linux-gnu' },
      { id: 'macos-arm64', runner: 'macos-14', target: 'aarch64-apple-darwin' },
    ],
  });
});

// target_id: resolvePlatformMatrix(string)
test('rejects empty, extra, and malformed manifest structures', () => {
  // Arrange
  const inputs = ['platforms: []\n', 'platforms: []\nextra: true\n', 'platforms:\n  - id: linux\n    runner: ubuntu-24.04\n'];

  // Act
  const failures = inputs.map((input) => captureFailure(() => resolvePlatformMatrix(input)));

  // Assert
  assert.match(String(failures[0]), /platform-matrix-platforms-empty/);
  assert.match(String(failures[1]), /platform-matrix-root-invalid/);
  assert.match(String(failures[2]), /platform-matrix-platform-0-shape-invalid/);
});

// target_id: resolvePlatformMatrix(string)
test('rejects duplicate identities, duplicate targets, and unsupported runners', () => {
  // Arrange
  const inputs = [validManifest.replace('macos-arm64', 'linux-x64'), validManifest.replace('aarch64-apple-darwin', 'x86_64-unknown-linux-gnu'), validManifest.replace('macos-14', 'ubuntu-latest')];

  // Act
  const failures = inputs.map((input) => captureFailure(() => resolvePlatformMatrix(input)));

  // Assert
  assert.match(String(failures[0]), /platform-matrix-platform-1-id-invalid/);
  assert.match(String(failures[1]), /platform-matrix-platform-1-target-invalid/);
  assert.match(String(failures[2]), /platform-matrix-platform-1-runner-invalid/);
});

// target_id: resolvePlatformMatrix(string)
test('rejects manifests beyond the bounded input size', () => {
  // Arrange
  const manifest = `platforms:\n${' '.repeat(64 * 1024)}`;

  // Act
  const failure = captureFailure(() => resolvePlatformMatrix(manifest));

  // Assert
  assert.match(String(failure), /platform-matrix-manifest-too-large/);
});
