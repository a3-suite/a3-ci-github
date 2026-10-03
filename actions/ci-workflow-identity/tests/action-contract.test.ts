import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';

// integration_id: ci-workflow-identity-action-contract
test('action.yml exposes the workflow identity contract', () => {
  // Arrange
  const action = readFileSync(path.resolve(path.resolve(__dirname, '..'), 'action.yml'), 'utf8');
  const inputs = [
    'repository',
    'default-branch',
    'expected-caller-workflow-path',
    'expected-called-workflow-path',
    'caller-workflow-ref',
    'caller-workflow-sha',
    'called-workflow-repository',
    'called-workflow-file-path',
    'called-workflow-ref',
    'called-workflow-sha',
  ];
  // Act + Assert
  assert.match(action, /^name: ci-workflow-identity$/m);
  for (const input of inputs) {
    assert.match(action, new RegExp(`^  ${input}:\\n    required: true$`, 'm'));
  }
  assert.match(action, /^outputs:\n  sha:$/m);
  assert.match(action, /^  using: node24$/m);
  assert.match(action, /^  main: dist\/index\.js$/m);
});
