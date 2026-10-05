import fs from 'node:fs';
import path from 'node:path';
import { describe, test, expect } from 'vitest';
import { parse } from 'yaml';

describe('ci-config-snapshot-action-contract', () => {
  // integration_id: ci-config-snapshot-action-contract
  test('action.yml exposes the config snapshot contract', () => {
    // Arrange
    const root = path.resolve(__dirname, '..');
    // Act
    const action = parse(fs.readFileSync(path.join(root, 'action.yml'), 'utf8')) as any;
    // Assert
    expect(action.name).toBe('ci-config-snapshot');
    expect(Object.keys(action.inputs)).toStrictEqual(['sources-json', 'snapshot-path', 'output-path']);
    expect(Object.keys(action.outputs)).toStrictEqual(['status', 'snapshot-path', 'digest']);
    expect(action.runs.using).toBe('node24');
  });
});
