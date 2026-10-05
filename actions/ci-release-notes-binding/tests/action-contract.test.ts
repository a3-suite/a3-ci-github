import fs from 'node:fs';
import path from 'node:path';
import { describe, test, expect } from 'vitest';
import { parse } from 'yaml';

describe('ci-release-notes-binding-action-contract', () => {
  // integration_id: ci-release-notes-binding-action-contract
  test('action.yml exposes the release notes binding contract', () => {
    // Arrange
    const root = path.resolve(__dirname, '..');
    // Act
    const action = parse(fs.readFileSync(path.join(root, 'action.yml'), 'utf8')) as any;
    // Assert
    expect(action.name).toBe('ci-release-notes-binding');
    expect(Object.keys(action.outputs)).toStrictEqual(['status', 'release-identity', 'digest', 'approval-id']);
    expect(action.runs.using).toBe('node24');
  });
});
