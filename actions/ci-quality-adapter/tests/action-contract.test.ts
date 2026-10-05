import fs from 'node:fs';
import path from 'node:path';
import { describe, test, expect } from 'vitest';
import { parse } from 'yaml';

describe('ci-quality-adapter-action-contract', () => {
  // integration_id: ci-quality-adapter-action-contract
  test('action contract keeps workflow trust inputs explicit', () => {
    // Arrange
    const source = fs.readFileSync(path.resolve(__dirname, '../action.yml'), 'utf8');

    // Act
    const action = parse(source) as any;

    // Assert
    expect(action.name).toBe('ci-quality-adapter');
    expect(action.inputs['source-root'].required).toBe(true);
    expect(action.inputs['trusted-project-root'].required).toBe(false);
    expect(Object.keys(action.outputs)).toStrictEqual(['status', 'result-path']);
    expect(action.runs.using).toBe('node24');
  });
});
