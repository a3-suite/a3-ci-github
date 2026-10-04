import fs from 'node:fs';
import path from 'node:path';
import { describe, test, expect } from 'vitest';
import { parse } from 'yaml';

describe('ci-handoff-integrity-action-contract', () => {
  // integration_id: ci-handoff-integrity-action-contract
  test('action.yml exposes the handoff integrity contract', () => {
    // Arrange
    const root = path.resolve(__dirname, '..');
    // Act
    const action = parse(fs.readFileSync(path.join(root, 'action.yml'), 'utf8')) as any;
    // Assert
    expect(action.name).toBe('ci-handoff-integrity');
    expect(Object.keys(action.outputs)).toStrictEqual(['status', 'descriptor', 'manifest', 'manifest-digest', 'entries']);
    expect(action.runs.using).toBe('node24');
  });
});
