import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';

// integration_id: ci-change-scope-action-contract
test('action.yml exposes the change scope contract', () => {
  // Arrange
  const root = path.resolve(__dirname, '..');
  // Act
  const action = parse(fs.readFileSync(path.join(root, 'action.yml'), 'utf8')) as any;
  // Assert
  assert.equal(action.name, 'ci-change-scope');
  assert.deepEqual(Object.keys(action.outputs), ['status', 'run-ci', 'run-docs', 'files', 'docs-files', 'other-files']);
  assert.equal(action.runs.using, 'node24');
});
