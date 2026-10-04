import fs from 'node:fs';
import path from 'node:path';
import { describe, test, expect } from 'vitest';
import { parse } from 'yaml';
const root = path.resolve(__dirname, '..');
describe('ci-vitest-summary-action-contract', () => {
  // integration_id: ci-vitest-summary-action-contract
  test('action.yml matches the public contract', () => {
    // Arrange
    const actionPath = path.join(root, 'action.yml');
    const actionContents = fs.readFileSync(actionPath, 'utf8');
    const contract = JSON.parse(fs.readFileSync(path.join(__dirname, 'contract.json'), 'utf8')) as any;

    // Act
    const action = parse(actionContents) as any;
    // Assert
    expect(action.name).toBe(contract.name); expect(action.inputs).toStrictEqual(contract.inputs); expect(Object.keys(action.outputs)).toStrictEqual(contract.outputs); expect(action.runs.using).toBe(contract.runtime);
  });
});
