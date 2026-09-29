import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';

// integration_id: ci-quality-adapter-action-contract
test('action contract keeps workflow trust inputs explicit', () => {
  // Arrange
  const source = fs.readFileSync(path.resolve(__dirname, '../action.yml'), 'utf8');

  // Act
  const action = parse(source) as any;

  // Assert
  assert.equal(action.name, 'ci-quality-adapter');
  assert.equal(action.inputs['source-root'].required, true);
  assert.equal(action.inputs['trusted-project-root'].required, false);
  assert.deepEqual(Object.keys(action.outputs), ['status', 'result-path']);
  assert.equal(action.runs.using, 'node24');
});
