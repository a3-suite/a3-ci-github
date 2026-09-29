import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';

// integration_id: ci-platform-matrix-action-contract
test('action.yml exposes the platform matrix contract', () => {
  // Arrange
  const root = path.resolve(__dirname, '..');
  // Act
  const action = parse(fs.readFileSync(path.join(root, 'action.yml'), 'utf8')) as any;
  // Assert
  assert.equal(action.name, 'ci-platform-matrix');
  assert.deepEqual(Object.keys(action.inputs), ['manifest-path']);
  assert.equal(action.inputs['manifest-path'].required, true);
  assert.match(action.inputs['manifest-path'].description, /only root key is a non-empty platforms list/);
  assert.match(action.inputs['manifest-path'].description, /\[a-z0-9\]\[a-z0-9-\]\*/);
  assert.match(action.inputs['manifest-path'].description, /ubuntu-24\.04, macos-14, or windows-2022/);
  assert.match(action.inputs['manifest-path'].description, /id and target values must each be unique/);
  assert.deepEqual(Object.keys(action.outputs), ['matrix']);
  assert.match(action.outputs.matrix.description, /failures do not produce this output/);
  assert.equal(action.runs.using, 'node24');
  assert.equal(action.runs.main, 'dist/index.js');
});
