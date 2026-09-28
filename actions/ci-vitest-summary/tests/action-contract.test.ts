import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
const root = path.resolve(__dirname, '..');
// integration_id: ci-vitest-summary-action-contract
test('action.yml matches the public contract', () => {
  // Arrange
  const actionPath = path.join(root, 'action.yml');
  const actionContents = fs.readFileSync(actionPath, 'utf8');
  const contract = JSON.parse(fs.readFileSync(path.join(__dirname, 'contract.json'), 'utf8')) as any;

  // Act
  const action = parse(actionContents) as any;
  // Assert
  assert.equal(action.name, contract.name); assert.deepEqual(action.inputs, contract.inputs); assert.deepEqual(Object.keys(action.outputs), contract.outputs); assert.equal(action.runs.using, contract.runtime);
});
