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
    expect(Object.keys(action.inputs).sort()).toStrictEqual(['cargo-audit-version', 'language-profile', 'toolchain-version', 'uv-version']);
    expect(action.inputs['language-profile'].required).toBe(true);
    expect(action.inputs['toolchain-version'].required).toBe(true);
    expect(action.outputs).toBe(undefined);
    expect(action.runs.steps[0].name).toBe('Validate selected toolchain inputs');
    const registry = yaml.parse(fs.readFileSync(path.join(root, 'skills/ci-github/references/ci-github-preset-assets.reference.yml'), 'utf8'));
    const pins = new Map(registry.providerActions.entries.map((entry) => [entry.action, entry.commitSha]));
    const dependencies = action.runs.steps.filter((step) => step.uses);
    expect(dependencies.map((step) => step.uses.split('@')[0])).toStrictEqual(['actions/setup-node', 'actions/setup-python', 'astral-sh/setup-uv']);
    for (const step of dependencies) {
      const [name, sha] = step.uses.split('@'); expect(sha).toBe(pins.get(name));
      expect(sha).toMatch(/^[a-f0-9]{40}$/);
    }
    expect(action.runs.steps.slice(1).map((step) => step.if)).toStrictEqual(["inputs.language-profile == 'typescript'", "inputs.language-profile == 'python'", "inputs.language-profile == 'python'", "inputs.language-profile == 'rust'", "inputs.language-profile == 'rust'"]);
    expect(dependencies[0].with.cache).toBe('npm');
    expect(dependencies[0].with['node-version']).toStrictEqual('${{ inputs.toolchain-version }}');
    expect(dependencies[1].with['python-version']).toStrictEqual('${{ inputs.toolchain-version }}');
    expect(dependencies[2].with).toStrictEqual({ version: '${{ inputs.uv-version }}', 'python-version': '${{ inputs.toolchain-version }}' });
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
      expect(result.stderr).toMatch(/quality-toolchain-(profile|version|uv-version|cargo-audit-version)-invalid/);
    }
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
      const env = { ...selected('rust', '1.90.0', '', '0.21.0'), PATH: bin + path.delimiter + process.env.PATH, CAPTURE_LOG: log, GITHUB_ENV: output };
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
});
