import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';

// integration_id: ci-release-publication-control-action-contract
test('action contract exposes publication operations', () => {
  // Arrange
  const source = fs.readFileSync(path.resolve(__dirname, '../action.yml'), 'utf8');

  // Act
  const action = parse(source) as any;

  // Assert
  assert.equal(action.name, 'ci-release-publication-control');
  assert.equal(action.inputs.operation.required, true);
  assert.equal(action.inputs['release-request-workflow-name'], undefined);
  assert.equal(action.inputs['release-request-workflow-path'], undefined);
  assert.deepEqual(Object.keys(action.outputs), ['status', 'request-run-id']);
  assert.equal(action.runs.using, 'node24');
});
