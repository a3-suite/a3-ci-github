import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, describe, expect } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const yaml = createRequire(path.join(root, 'runtime/preset/package.json'))('yaml');
const action = yaml.parse(fs.readFileSync(path.join(root, 'actions/ci-quality-toolchain/action.yml'), 'utf8'));
const run = (script, env = {}, cwd = root) => spawnSync('bash', ['-c', script], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
const selected = (profile, version, uv = '', audit = '') => ({ CI_LANGUAGE_PROFILE: profile, CI_TOOLCHAIN_VERSION: version, CI_UV_VERSION: uv, CI_CARGO_AUDIT_VERSION: audit });

describe("contract.ci-quality-toolchain.preparation", () => {
  // contract_id: contract.ci-quality-toolchain.preparation
  test('quality toolchain contract selects only fixed profile dependencies without project execution', () => {
    expect(action.runs.using).toBe('composite');
    expect(Object.keys(action.inputs).sort()).toStrictEqual(['cargo-audit-version', 'language-profile', 'toolchain-version', 'uv-version', 'version-policy']);
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
  test('quality toolchain validation accepts selected exact versions and rejects invalid inputs before setup', () => {
    const script = action.runs.steps[0].run;
    for (const env of [selected('typescript', '24.0.0'), selected('python', '3.13.1', '0.8.0'), selected('rust', '1.90.0', '', '0.21.0'), selected('typescript', '24.0.0', '<unused>', '<unused>')]) expect(run(script, env).status).toBe(0);
    for (const env of [selected('unknown', '24.0.0'), selected('', '24.0.0'), selected('typescript', ''), selected('typescript', 'latest'), selected('typescript', '24'), selected('typescript', '24.0'), selected('typescript', '<toolchain-version>'), selected('typescript', '24.0.0\n'), selected('python', '3.13.1'), selected('python', '3.13.1', 'latest'), selected('rust', '1.90.0'), selected('rust', '1.90.0', '', 'latest'), selected('rust', 'stable', '', '0.21.0')]) {
      const result = run(script, env); expect(result.status, JSON.stringify(env)).not.toBe(0);
      expect(result.stderr).toMatch(/quality-toolchain-(profile|version(?:-policy)?|uv-version|cargo-audit-version)-invalid/);
    }
  });

  // contract_id: contract.ci-quality-toolchain.preparation
  test('compatible policy accepts bounded Node and Python selectors while exact policy stays strict', () => {
    const script = action.runs.steps[0].run;
    expect(run(script, { ...selected('typescript', '24.21.0'), CI_VERSION_POLICY: 'unknown' }).status).not.toBe(0);
    for (const env of [selected('typescript', '24'), selected('typescript', '24.21'), selected('python', '3.12', '0.8.0')]) {
      expect(run(script, { ...env, CI_VERSION_POLICY: 'compatible' }).status).toBe(0);
      expect(run(script, { ...env, CI_VERSION_POLICY: 'exact' }).status).not.toBe(0);
    }
    for (const env of [selected('typescript', '24.x'), selected('typescript', '>=24'), selected('python', '3', '0.8.0'), selected('rust', 'stable', '', '0.21.0')]) {
      expect(run(script, { ...env, CI_VERSION_POLICY: 'compatible' }).status).not.toBe(0);
    }
  });

  // contract_id: contract.ci-quality-toolchain.preparation
  test('resolved output matches the selector and is published only after selected setup', () => {
    const directory = fs.mkdtempSync(path.join(root, 'tmp/quality-toolchain-resolution-'));
    const resolve = action.runs.steps.find((step) => step.id === 'resolve-version');
    const publish = action.runs.steps.find((step) => step.id === 'publish-version');
    try {
      for (const [profile, requested, observed, expected] of [
        ['typescript', '24', 'v24.21.0', '24.21.0'],
        ['typescript', '24.21', '24.21.0', '24.21.0'],
        ['python', '3.12', '3.12.6', '3.12.6'],
        ['typescript', '24.21.0', 'v24.21.0', '24.21.0'],
        ['rust', '1.90.0', '', '1.90.0'],
        ['typescript', '24', '', undefined],
        ['typescript', '24', 'v26.0.0', undefined],
        ['typescript', '24.21', '24.210.0', undefined],
        ['python', '3.12', '3.13.1', undefined],
        ['typescript', '24.21.0', '24.21.1', undefined],
        ['typescript', '24', '24.21.0\n', undefined],
      ]) {
        const output = path.join(directory, 'resolve-output');
        fs.writeFileSync(output, '');
        const result = run(resolve.run, { ...selected(profile, requested), GITHUB_OUTPUT: output,
          CI_NODE_VERSION: profile === 'typescript' ? observed : '', CI_PYTHON_VERSION: profile === 'python' ? observed : '' });
        expect(result.status === 0, `${profile}/${requested}/${observed}: ${result.stderr}`).toBe(expected !== undefined);
        expect(fs.readFileSync(output, 'utf8')).toBe(expected ? `version=${expected}\n` : '');
      }
      const output = path.join(directory, 'publish-output');
      expect(run(publish.run, { CI_RESOLVED_VERSION: '24.21.0', GITHUB_OUTPUT: output }).status).toBe(0);
      expect(fs.readFileSync(output, 'utf8')).toBe('version=24.21.0\n');
      expect(action.runs.steps.indexOf(publish)).toBeGreaterThan(action.runs.steps.findIndex((step) => step.id === 'cargo-audit'));
      expect(publish.if).toBeUndefined();
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  // contract_id: contract.ci-quality-toolchain.preparation
  test('quality toolchain Rust scripts preserve pinned arguments environment and setup failures', () => {
    fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
    const directory = fs.mkdtempSync(path.join(root, 'tmp/quality-toolchain-'));
    try {
      const bin = path.join(directory, 'bin'); fs.mkdirSync(bin);
      for (const [name, variable] of [['rustup', 'RUSTUP_EXIT'], ['cargo', 'CARGO_EXIT']]) {
        fs.writeFileSync(path.join(bin, name), '#!/bin/bash\nprintf "%s\\n" "$*" >> "$CAPTURE_LOG"\nexit "${' + variable + ':-0}"\n', { mode: 0o700 });
      }
      const log = path.join(directory, 'calls'); const output = path.join(directory, 'github-env');
      const env = { ...selected('rust', '1.90.0', '', '0.21.0'), PATH: bin + path.delimiter + process.env.PATH, CAPTURE_LOG: log, GITHUB_ENV: output,
        GITHUB_ACTION_PATH: path.join(root, 'actions/ci-quality-toolchain') };
      const rust = action.runs.steps.find((step) => step.name === 'Set up Rust toolchain').run;
      const audit = action.runs.steps.find((step) => step.name === 'Set up cargo-audit').run;
      expect(run(rust, env, directory).status).toBe(0);
      expect(run(audit, env, directory).status).toBe(0);
      expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toStrictEqual(['toolchain install 1.90.0 --profile minimal --component rustfmt --component clippy', 'install cargo-audit --locked --version 0.21.0']);
      expect(fs.readFileSync(output, 'utf8')).toBe('RUSTUP_TOOLCHAIN=1.90.0\n');
      fs.unlinkSync(output);
      expect(run(rust, { ...env, RUSTUP_EXIT: '13' }, directory).status).toBe(13);
      expect(fs.existsSync(output)).toBe(false);
      expect(run(audit, { ...env, CARGO_EXIT: '17' }, directory).status).toBe(17);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  // contract_id: contract.ci-quality-toolchain.preparation
  // integration_id: quality-toolchain-failure-retention
  test('failure retention identifies the failed setup without executing another setup', () => {
    const step = action.runs.steps.at(-1);
    expect(step.if).toBe('failure()');
    const result = run(step.run, {
      GITHUB_ACTION_PATH: path.join(root, 'actions/ci-quality-toolchain'),
      VALIDATE_RESULT: 'success', TYPESCRIPT_RESULT: 'skipped', PYTHON_RESULT: 'skipped',
      UV_RESULT: 'skipped', RUST_RESULT: 'failure', CARGO_AUDIT_RESULT: 'skipped',
    });
    expect(result.status).toBe(0);
    const line = result.stderr.split('\n').find(value => value.startsWith('ci-failure-diagnostic:'));
    const evidence = JSON.parse(line.slice('ci-failure-diagnostic:'.length));
    expect(evidence.classification).toMatchObject({ subject: 'ci-quality-toolchain', stage: 'rust-setup' });
    expect(evidence['execution-state']).toMatchObject({ outcome: 'failure', write: 'runner-toolchain-may-be-partial' });
    expect(evidence['next-check'].rule).toBe('rust-setup');
  });

});
