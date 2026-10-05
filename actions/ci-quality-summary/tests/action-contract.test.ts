import fs from 'node:fs';
import path from 'node:path';
import { describe, test, expect } from 'vitest';
import { parse } from 'yaml';

const testsDir = __dirname;
const root = path.resolve(testsDir, '..');

describe('ci-quality-summary-action-contract', () => {
  // integration_id: ci-quality-summary-action-contract
  test('action.yml matches the checked-in public contract fixture', () => {
    // Arrange
    const actionPath = path.join(root, 'action.yml');
    const actionContents = fs.readFileSync(actionPath, 'utf8');
    const contract = JSON.parse(
      fs.readFileSync(path.join(testsDir, 'ci-quality-summary-contract.json'), 'utf8'),
    ) as {
      name: string;
      inputs: Record<string, { required: boolean; default?: string }>;
      outputs: string[];
      runtime: string;
    };

    // Act
    const action = parse(actionContents) as {
      name: string;
      inputs: Record<string, { required: boolean; default?: string }>;
      outputs: Record<string, unknown>;
      runs: { using: string };
    };

    // Assert
    expect(action.name).toBe(contract.name);
    expect(action.inputs).toStrictEqual(contract.inputs);
    expect(Object.keys(action.outputs)).toStrictEqual(contract.outputs);
    expect(action.runs.using).toBe(contract.runtime);
  });
});
