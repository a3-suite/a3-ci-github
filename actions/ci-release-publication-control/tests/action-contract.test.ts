import fs from 'node:fs';
import path from 'node:path';
import { describe, test, expect } from 'vitest';
import { parse } from 'yaml';

describe('ci-release-publication-control-action-contract', () => {
  // integration_id: ci-release-publication-control-action-contract
  test('action contract exposes publication operations', () => {
    // Arrange
    const source = fs.readFileSync(path.resolve(__dirname, '../action.yml'), 'utf8');

    // Act
    const action = parse(source) as any;

    // Assert
    expect(action.name).toBe('ci-release-publication-control');
    expect(action.inputs.operation.required).toBe(true);
    expect(action.inputs['release-request-workflow-name']).toBe(undefined);
    expect(action.inputs['release-request-workflow-path']).toBe(undefined);
    expect(Object.keys(action.outputs)).toStrictEqual(['status', 'request-run-id']);
    expect(action.runs.using).toBe('node24');
  });
});
