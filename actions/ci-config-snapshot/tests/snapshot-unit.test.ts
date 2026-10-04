import { describe, test, expect } from 'vitest';
import { resolveConfigSnapshot } from '../src/snapshot.js';

describe('resolveConfigSnapshot(unknown)', () => {
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
    expect({ ...result.values }).toStrictEqual({ RUST_VERSION: '1.91.1', CHANNEL: 'candidate', TARGET: 'macos-arm64' });
    expect(result.digest).toBe(repeated.digest);
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
    expect(String(failures[0])).toMatch(/config-snapshot-key-invalid/);
    expect(String(failures[1])).toMatch(/config-snapshot-runtime-value-invalid/);
  });
});
