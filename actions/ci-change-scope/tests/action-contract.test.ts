import fs from 'node:fs';
import path from 'node:path';
import { describe, test, expect } from 'vitest';
import { parse } from 'yaml';

describe('ci-change-scope-action-contract', () => {
  // integration_id: ci-change-scope-action-contract
  test('action.yml exposes the change scope contract', () => {
    // Arrange
    const root = path.resolve(__dirname, '..');
    // Act
    const action = parse(fs.readFileSync(path.join(root, 'action.yml'), 'utf8')) as any;
    // Assert
    expect(action.name).toBe('ci-change-scope');
    expect(Object.keys(action.outputs)).toStrictEqual(['status', 'run-ci', 'run-docs', 'files', 'docs-files', 'other-files']);
    expect(action.runs.using).toBe('node24');
  });
});
