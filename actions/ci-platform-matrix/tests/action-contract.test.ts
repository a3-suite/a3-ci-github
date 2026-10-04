import fs from 'node:fs';
import path from 'node:path';
import { describe, test, expect } from 'vitest';
import { parse } from 'yaml';

describe('ci-platform-matrix-action-contract', () => {
  // integration_id: ci-platform-matrix-action-contract
  test('action.yml exposes the platform matrix contract', () => {
    // Arrange
    const root = path.resolve(__dirname, '..');
    // Act
    const action = parse(fs.readFileSync(path.join(root, 'action.yml'), 'utf8')) as any;
    // Assert
    expect(action.name).toBe('ci-platform-matrix');
    expect(Object.keys(action.inputs)).toStrictEqual(['manifest-path', 'selection-path']);
    expect(action.inputs['manifest-path'].required).toBe(true);
    expect(action.inputs['manifest-path'].description).toMatch(/only root key is a non-empty platforms list/);
    expect(action.inputs['manifest-path'].description).toMatch(/\[a-z0-9\]\[a-z0-9-\]\*/);
    expect(action.inputs['manifest-path'].description).toMatch(/ubuntu-24\.04, macos-14, or windows-2022/);
    expect(action.inputs['manifest-path'].description).toMatch(/id and target values must each be unique/);
    expect(Object.keys(action.outputs)).toStrictEqual(['matrix', 'quality-matrix', 'expected-platforms']);
    expect(action.outputs.matrix.description).toMatch(/failures do not produce this output/);
    expect(action.inputs['selection-path'].required).toBe(false);
    expect(action.outputs['quality-matrix'].description).toMatch(/platform_id and runner in selection order/);
    expect(action.outputs['expected-platforms'].description).toMatch(/Comma-separated selected platform IDs/);
    expect(action.runs.using).toBe('node24');
    expect(action.runs.main).toBe('dist/index.js');
  });
});
