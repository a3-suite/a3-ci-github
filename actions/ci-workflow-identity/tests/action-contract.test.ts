import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test, expect } from 'vitest';

describe('ci-workflow-identity-action-contract', () => {
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
    expect(action).toMatch(/^name: ci-workflow-identity$/m);
    for (const input of inputs) {
      expect(action).toMatch(new RegExp(`^  ${input}:\\n    required: true$`, 'm'));
    }
    expect(action).toMatch(/^outputs:\n  sha:$/m);
    expect(action).toMatch(/^  using: node24$/m);
    expect(action).toMatch(/^  main: dist\/index\.js$/m);
  });
});
