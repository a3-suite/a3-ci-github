import fs from 'node:fs';
import path from 'node:path';
import { describe, test, expect } from 'vitest';
import { parse } from 'yaml';

describe('ci-package-publication-request-action-contract', () => {
  // integration_id: ci-package-publication-request-action-contract
  test('action contract exposes create and verify inputs', () => {
    // Arrange
    const source = fs.readFileSync(path.resolve(__dirname, '../action.yml'), 'utf8');

    // Act
    const action = parse(source) as any;

    // Assert
    expect(action.name).toBe('ci-package-publication-request');
    expect(action.inputs.operation.required).toBe(true);
    expect(Object.keys(action.outputs)).toStrictEqual(['status', 'request-path', 'source-sha', 'version', 'target-identity', 'language-profile', 'toolchain']);
    expect(action.runs.using).toBe('node24');
  });
});
