import { strict as assert } from 'node:assert';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathsReferToSameFile } from '../src/index.js';
// integration_id: ci-config-snapshot-source
test('detects command-file collisions before writing a snapshot', () => {
  // Arrange
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a3-config-snapshot-'));
  const snapshot = path.join(root, 'snapshot.json');
  // Act
  const same = pathsReferToSameFile(snapshot, snapshot);
  const different = pathsReferToSameFile(snapshot, path.join(root, 'outputs'));
  // Assert
  assert.equal(same, true);
  assert.equal(different, false);
});
