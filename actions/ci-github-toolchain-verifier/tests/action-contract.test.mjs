import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { accessSync, chmodSync, constants, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const action = readFileSync(path.join(root, 'action.yml'), 'utf8');
const script = path.resolve(root, '../../runtime/github-toolchain/verify-github-toolchain.sh');

const runBlock = () => {
  const match = action.match(/^      run: \|\n((?: {8}.*\n?)+)/m);
  assert.ok(match, 'action.yml must contain a composite run block');
  return match[1].replace(/^ {8}/gm, '');
};

const withCompositeFixture = (callback) => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'a3-ci-github-composite-'));
  const output = path.join(fixture, 'github-output');
  try {
    writeFileSync(output, '');
    for (const [name, content] of Object.entries({
      gh: "#!/usr/bin/env bash\necho 'gh version 2.80.0 (test)'\n",
      jq: "#!/usr/bin/env bash\necho 'jq-1.7'\n",
      sha256sum: "#!/usr/bin/env bash\necho 'sha256sum (GNU coreutils) 9.5'\n",
    })) {
      const command = path.join(fixture, name);
      writeFileSync(command, content);
      chmodSync(command, 0o755);
    }
    callback({ fixture, output });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
};

const runComposite = ({ fixture, output }, overrides = {}) => spawnSync('/bin/bash', ['-euo', 'pipefail', '-c', runBlock()], {
  encoding: 'utf8',
  env: {
    ...process.env,
    PATH: `${fixture}:${process.env.PATH}`,
    GITHUB_ACTION_PATH: root,
    GITHUB_OUTPUT: output,
    VERIFY_MODE: 'gh-jq-sha256',
    CI_GH_VERSION: '2.80.0',
    CI_JQ_VERSION: '1.7',
    CI_SHA256SUM_VERSION: '9.5',
    ...overrides,
  },
});

// integration_id: ci-github-toolchain-verifier-action-regression
test('action.yml exposes a thin composite contract for the shared script', () => {
  // Arrange
  const actionPath = path.join(root, 'action.yml');
  // Act
  const action = readFileSync(actionPath, 'utf8');
  // Assert
  assert.match(action, /^name: ci-github-toolchain-verifier$/m);
  assert.match(action, /^  using: composite$/m);
  for (const input of ['mode', 'gh-version', 'jq-version', 'sha256sum-version']) {
    assert.match(action, new RegExp(`^  ${input}:$`, 'm'));
  }
  assert.match(action, /^  verified:$/m);
  assert.match(action, /^    value: \$\{\{ steps\.verify\.outputs\.verified \}\}$/m);
  assert.match(action, /runtime\/github-toolchain\/verify-github-toolchain\.sh/);
  assert.match(action, /^        VERIFY_MODE: \$\{\{ inputs\.mode \}\}$/m);
  assert.match(action, /verify-github-toolchain\.sh\" \"\$VERIFY_MODE\"/);
  accessSync(script, constants.R_OK | constants.X_OK);
});

// contract_id: contract.ci-github-toolchain-verifier.outputs
// integration_id: ci-github-toolchain-verifier-action
test('composite run exposes verified only after exact toolchain verification', () => withCompositeFixture((fixture) => {
  // Arrange
  const successInput = fixture;
  // Act
  const success = runComposite(successInput);
  // Assert
  assert.equal(success.status, 0, success.stderr);
  assert.equal(readFileSync(fixture.output, 'utf8'), 'verified=true\n');

  // Arrange
  writeFileSync(fixture.output, '');
  // Act
  const failure = runComposite(fixture, { CI_JQ_VERSION: '1.6' });
  // Assert
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /jq-version-mismatch/);
  assert.equal(readFileSync(fixture.output, 'utf8'), '');
}));
