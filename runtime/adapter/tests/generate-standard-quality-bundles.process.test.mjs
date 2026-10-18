import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, describe, expect } from 'vitest';
import { root } from "./generate-standard-quality-bundles.fixtures.mjs";

describe('adapter-bundle-materialization-contract', () => {

  // flow_id: adapter-bundle-materialization-contract
  test('standard bundle generator CLI needs no external checkout and rejects legacy source arguments', () => {
    // Arrange
    const generator = path.join(root, 'runtime/adapter/generate-standard-quality-bundles.mjs');
    // Act
    const checked = spawnSync(process.execPath, [generator, '--check'], { encoding: 'utf8', cwd: root });
    const rejected = spawnSync(process.execPath, [generator, '--source-root', '/unavailable', '--source-revision', 'a'.repeat(40)], { encoding: 'utf8', cwd: root });
    // Assert
    expect(checked.status, checked.stderr).toBe(0);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toMatch(/generation-arguments-invalid/);
  });
});
