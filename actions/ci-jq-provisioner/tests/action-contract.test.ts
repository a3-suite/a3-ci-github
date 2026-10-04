import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test, expect } from 'vitest';

describe('ci-jq-provisioner-action-contract', () => {
  // integration_id: ci-jq-provisioner-action-contract
  test('action.yml exposes the jq provisioning contract', () => {
    // Arrange
    const action = readFileSync(path.resolve(path.resolve(__dirname, '..'), 'action.yml'), 'utf8');
    // Act + Assert
    expect(action).toMatch(/^name: ci-jq-provisioner$/m);
    expect(action).toMatch(/^  jq-version:\n    description: .+\n    required: true$/m);
    expect(action).not.toMatch(/^outputs:/m);
    expect(action).toMatch(/^  using: node24$/m);
    expect(action).toMatch(/^  main: dist\/index\.js$/m);
  });
});
