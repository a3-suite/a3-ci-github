import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';

// integration_id: ci-package-publication-request-action-contract
test('action contract exposes create and verify inputs', () => {
  // Arrange
  const source = fs.readFileSync(path.resolve(__dirname, '../action.yml'), 'utf8');

  // Act
  const action = parse(source) as any;

  // Assert
  assert.equal(action.name, 'ci-package-publication-request');
  assert.equal(action.inputs.operation.required, true);
  assert.deepEqual(Object.keys(action.outputs), ['status', 'request-path', 'source-sha', 'version', 'target-identity', 'language-profile', 'toolchain']);
  assert.equal(action.runs.using, 'node24');
});
