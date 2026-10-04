import fs from 'node:fs';
import path from 'node:path';
import { describe, test, expect } from 'vitest';
import { parse } from 'yaml';

describe('ci-publish-version-action-contract', () => {
  // integration_id: ci-publish-version-action-contract
  test('action.yml exposes the publish version contract', () => {
    // Arrange
    const root = path.resolve(__dirname, '..');
    // Act
    const action = parse(fs.readFileSync(path.join(root, 'action.yml'), 'utf8')) as any;
    // Assert
    expect(action.name).toBe('ci-publish-version');
    expect(Object.keys(action.inputs)).toStrictEqual(['version-plan-json']);
    expect(Object.keys(action.outputs)).toStrictEqual(['status', 'publish-version']);
    expect(action.runs.using).toBe('node24');
  });
});
