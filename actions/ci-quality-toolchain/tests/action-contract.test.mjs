import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test, describe, expect } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const yaml = createRequire(path.join(root, 'runtime/preset/package.json'))('yaml');
const action = yaml.parse(fs.readFileSync(path.join(root, 'actions/ci-quality-toolchain/action.yml'), 'utf8'));
describe("contract.ci-quality-toolchain.preparation", () => {
  // contract_id: contract.ci-quality-toolchain.preparation
  test('quality toolchain contract selects only fixed profile dependencies without project execution', () => {
    expect(action.runs.using).toBe('composite');
    expect(Object.keys(action.inputs).sort()).toStrictEqual(['cargo-audit-version', 'cargo-deny-version', 'language-profile', 'toolchain-version', 'uv-version', 'version-policy']);
    expect(action.inputs['language-profile'].required).toBe(true);
    expect(action.inputs['toolchain-version'].required).toBe(true);
    expect(action.inputs['version-policy'].default).toBe('exact');
    expect(action.outputs['resolved-toolchain-version'].value).toBe('${{ steps.publish-version.outputs.version }}');
    expect(action.runs.steps[0].name).toBe('Validate selected toolchain inputs');
    const registry = yaml.parse(fs.readFileSync(path.join(root, 'skills/ci-github/assets/registry/ci-github-preset-assets.yml'), 'utf8'));
    const pins = new Map(registry.providerActions.entries.map((entry) => [entry.action, entry.commitSha]));
    const dependencies = action.runs.steps.filter((step) => step.uses);
    expect(dependencies.map((step) => step.uses.split('@')[0])).toStrictEqual(['actions/setup-node', 'actions/setup-python', 'astral-sh/setup-uv']);
    for (const step of dependencies) {
      const [name, sha] = step.uses.split('@'); expect(sha).toBe(pins.get(name));
      expect(sha).toMatch(/^[a-f0-9]{40}$/);
    }
    expect(action.runs.steps.filter((step) => step.uses || step.id === 'rust' || step.id === 'cargo-audit').map((step) => step.if)).toStrictEqual(["inputs.language-profile == 'typescript'", "inputs.language-profile == 'python'", "inputs.language-profile == 'python'", "inputs.language-profile == 'rust'", "inputs.language-profile == 'rust'"]);
    expect(dependencies[0].with.cache).toBe('npm');
    expect(dependencies[0].with['node-version']).toStrictEqual('${{ inputs.toolchain-version }}');
    expect(dependencies[1].with['python-version']).toStrictEqual('${{ inputs.toolchain-version }}');
    expect(dependencies[2].with).toStrictEqual({ version: '${{ inputs.uv-version }}', 'python-version': '${{ steps.resolve-version.outputs.version }}' });
    for (const step of action.runs.steps) {
      expect(step['continue-on-error']).toBe(undefined);
      expect(Boolean(step.run?.includes('eval '))).toBe(false);
    }
  });

  // contract_id: contract.ci-quality-toolchain.preparation
  test('cargo-deny setup runs only when its version is requested', () => {
    // Arrange
    const steps = action.runs.steps;
    // Act
    const setup = steps.find((step) => step.id === 'cargo-deny');
    const validation = steps.find((step) => step.id === 'validate-inputs');
    // Assert
    expect(action.inputs['cargo-deny-version']).toStrictEqual(expect.objectContaining({ required: false, default: '' }));
    expect(setup.if).toBe("inputs.language-profile == 'rust' && inputs.cargo-deny-version != ''");
    expect(setup.env).toStrictEqual({ CI_CARGO_DENY_VERSION: '${{ inputs.cargo-deny-version }}' });
    expect(setup.run).toBe('bash "${GITHUB_ACTION_PATH}/scripts/setup-cargo-deny.sh"');
    expect(steps.indexOf(setup)).toBeGreaterThan(steps.findIndex((step) => step.id === 'cargo-audit'));
    expect(steps.indexOf(setup)).toBeLessThan(steps.findIndex((step) => step.id === 'publish-version'));
    expect(validation.run).toContain("quality-toolchain-cargo-deny-version-invalid");
    expect(steps.at(-1).env.CARGO_DENY_RESULT).toBe('${{ steps.cargo-deny.outcome }}');
  });
});
