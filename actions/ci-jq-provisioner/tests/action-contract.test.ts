import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

// integration_id: ci-jq-provisioner-action-contract
test('action.yml exposes the jq provisioning contract', () => {
  // Arrange
  const action = readFileSync(path.resolve(process.cwd(), 'action.yml'), 'utf8');
  // Act + Assert
  assert.match(action, /^name: ci-jq-provisioner$/m);
  assert.match(action, /^  jq-version:\n    description: .+\n    required: true$/m);
  assert.doesNotMatch(action, /^outputs:/m);
  assert.match(action, /^  using: node24$/m);
  assert.match(action, /^  main: dist\/index\.js$/m);
});
