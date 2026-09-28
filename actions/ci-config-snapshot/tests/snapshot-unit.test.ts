import { strict as assert } from 'node:assert';
import test from 'node:test';
import { resolveConfigSnapshot } from '../src/snapshot.js';

// target_id: resolveConfigSnapshot(unknown)
test('runtime overrides workflow and preset deterministically', () => {
  // Arrange
  const input = {
    preset: { RUST_VERSION: '1.91.1', CHANNEL: 'stable' },
    workflow: { CHANNEL: 'candidate', TARGET: 'linux-x64' },
    runtime: { TARGET: 'macos-arm64' },
  };

  // Act
  const result = resolveConfigSnapshot(input);
  const repeated = resolveConfigSnapshot(input);

  // Assert
  assert.deepEqual({ ...result.values }, { RUST_VERSION: '1.91.1', CHANNEL: 'candidate', TARGET: 'macos-arm64' });
  assert.equal(result.digest, repeated.digest);
});

// target_id: resolveConfigSnapshot(unknown)
test('rejects unsafe keys and values', () => {
  // Arrange
  const inputs = [{ runtime: { 'bad-key': 'x' } }, { runtime: { TOKEN: 'line\nfeed' } }];

  // Act
  const failures = inputs.map((input) => {
    try {
      resolveConfigSnapshot(input);
    } catch (error) {
      return error;
    }
    return undefined;
  });

  // Assert
  assert.match(String(failures[0]), /config-snapshot-key-invalid/);
  assert.match(String(failures[1]), /config-snapshot-runtime-value-invalid/);
});
