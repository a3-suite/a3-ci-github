import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const yaml = createRequire(path.join(root, 'runtime/preset/package.json'))('yaml');
const action = yaml.parse(fs.readFileSync(path.join(root, 'actions/ci-quality-toolchain/action.yml'), 'utf8'));
const run = (script, env = {}, cwd = root) => spawnSync('bash', ['-c', script], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
const selected = (profile, version, uv = '', audit = '') => ({ CI_LANGUAGE_PROFILE: profile, CI_TOOLCHAIN_VERSION: version, CI_UV_VERSION: uv, CI_CARGO_AUDIT_VERSION: audit });

// contract_id: contract.ci-quality-toolchain.preparation
test('quality toolchain contract selects only fixed profile dependencies without project execution', () => {
  assert.equal(action.runs.using, 'composite');
  assert.deepEqual(Object.keys(action.inputs).sort(), ['cargo-audit-version', 'language-profile', 'toolchain-version', 'uv-version']);
  assert.equal(action.inputs['language-profile'].required, true);
  assert.equal(action.inputs['toolchain-version'].required, true);
  assert.equal(action.outputs, undefined);
  assert.equal(action.runs.steps[0].name, 'Validate selected toolchain inputs');
  const registry = yaml.parse(fs.readFileSync(path.join(root, 'skills/ci-github/references/ci-github-preset-assets.reference.yml'), 'utf8'));
  const pins = new Map(registry.providerActions.entries.map((entry) => [entry.action, entry.commitSha]));
  const dependencies = action.runs.steps.filter((step) => step.uses);
  assert.deepEqual(dependencies.map((step) => step.uses.split('@')[0]), ['actions/setup-node', 'actions/setup-python', 'astral-sh/setup-uv']);
  for (const step of dependencies) {
    const [name, sha] = step.uses.split('@'); assert.equal(sha, pins.get(name));
    assert.match(sha, /^[a-f0-9]{40}$/);
  }
  assert.deepEqual(action.runs.steps.slice(1).map((step) => step.if), ["inputs.language-profile == 'typescript'", "inputs.language-profile == 'python'", "inputs.language-profile == 'python'", "inputs.language-profile == 'rust'", "inputs.language-profile == 'rust'"]);
  assert.equal(dependencies[0].with.cache, 'npm');
  assert.deepEqual(dependencies[0].with['node-version'], '${{ inputs.toolchain-version }}');
  assert.deepEqual(dependencies[1].with['python-version'], '${{ inputs.toolchain-version }}');
  assert.deepEqual(dependencies[2].with, { version: '${{ inputs.uv-version }}', 'python-version': '${{ inputs.toolchain-version }}' });
  for (const step of action.runs.steps) {
    assert.equal(step['continue-on-error'], undefined);
    assert.equal(Boolean(step.run?.includes('eval ')), false);
  }
});

// contract_id: contract.ci-quality-toolchain.preparation
test('quality toolchain validation accepts selected exact versions and rejects invalid inputs before setup', () => {
  const script = action.runs.steps[0].run;
  for (const env of [selected('typescript', '24.0.0'), selected('python', '3.13.1', '0.8.0'), selected('rust', '1.90.0', '', '0.21.0'), selected('typescript', '24.0.0', '<unused>', '<unused>')]) assert.equal(run(script, env).status, 0);
  for (const env of [selected('unknown', '24.0.0'), selected('', '24.0.0'), selected('typescript', ''), selected('typescript', 'latest'), selected('typescript', '24'), selected('typescript', '24.0'), selected('typescript', '<toolchain-version>'), selected('typescript', '24.0.0\n'), selected('python', '3.13.1'), selected('python', '3.13.1', 'latest'), selected('rust', '1.90.0'), selected('rust', '1.90.0', '', 'latest'), selected('rust', 'stable', '', '0.21.0')]) {
    const result = run(script, env); assert.notEqual(result.status, 0, JSON.stringify(env));
    assert.match(result.stderr, /quality-toolchain-(profile|version|uv-version|cargo-audit-version)-invalid/);
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
    assert.equal(run(rust, env, directory).status, 0);
    assert.equal(run(audit, env, directory).status, 0);
    assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['toolchain install 1.90.0 --profile minimal --component rustfmt --component clippy', 'install cargo-audit --locked --version 0.21.0']);
    assert.equal(fs.readFileSync(output, 'utf8'), 'RUSTUP_TOOLCHAIN=1.90.0\n');
    fs.unlinkSync(output);
    assert.equal(run(rust, { ...env, RUSTUP_EXIT: '13' }, directory).status, 13);
    assert.equal(fs.existsSync(output), false);
    assert.equal(run(audit, { ...env, CARGO_EXIT: '17' }, directory).status, 17);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
