import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'verify-github-toolchain.sh');

const withToolchain = (callback) => {
  const bin = mkdtempSync(path.join(os.tmpdir(), 'a3-ci-github-toolchain-'));
  const commands = {
    gh: "#!/usr/bin/env bash\necho 'gh version 2.80.0 (test)'\n",
    jq: "#!/usr/bin/env bash\necho 'jq-1.7'\n",
    sha256sum: "#!/usr/bin/env bash\necho 'sha256sum (GNU coreutils) 9.5'\n",
  };
  try {
    for (const [name, content] of Object.entries(commands)) {
      const commandPath = path.join(bin, name);
      writeFileSync(commandPath, content);
      chmodSync(commandPath, 0o755);
    }
    for (const [name, target] of [
      ['awk', '/usr/bin/awk'],
      ['bash', '/bin/bash'],
      ['env', '/usr/bin/env'],
      ['sed', '/usr/bin/sed'],
    ]) {
      symlinkSync(target, path.join(bin, name));
    }
    callback(bin);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
};

const run = (bin, mode, overrides = {}) => spawnSync('/bin/bash', [script, mode], {
  encoding: 'utf8',
  env: {
    ...process.env,
    PATH: bin,
    CI_GH_VERSION: '2.80.0',
    CI_JQ_VERSION: '1.7',
    CI_SHA256SUM_VERSION: '9.5',
    ...overrides,
  },
});

// contract_id: contract.ci-github-toolchain-verifier.processing
// integration_id: ci-github-toolchain-script
test('accepts every supported verification mode', () => withToolchain((bin) => {
  // Arrange
  const modes = ['jq', 'gh-jq', 'jq-sha256', 'gh-jq-sha256'];
  // Act
  const results = modes.map((mode) => run(bin, mode));
  // Assert
  results.forEach((result, index) => assert.equal(result.status, 0, modes[index]));
}));

// contract_id: contract.ci-github-toolchain-verifier.processing
// integration_id: ci-github-toolchain-script
test('rejects an unsupported mode', () => withToolchain((bin) => {
  // Arrange
  const mode = 'all';
  // Act
  const result = run(bin, mode);
  // Assert
  assert.equal(result.status, 1);
  assert.match(result.stderr, /github-toolchain-mode-invalid/);
}));

// contract_id: contract.ci-github-toolchain-verifier.processing
// integration_id: ci-github-toolchain-script
test('rejects an unavailable selected command', () => {
  const cases = [
    ['jq', 'jq', 'jq-required'],
    ['gh-jq', 'gh', 'github-cli-required'],
    ['jq-sha256', 'sha256sum', 'sha256sum-required'],
  ];
  for (const [mode, command, diagnostic] of cases) {
    // Arrange
    withToolchain((bin) => {
      rmSync(path.join(bin, command));

      // Act
      const result = run(bin, mode);

      // Assert
      assert.equal(result.status, 1, `${mode} should reject a missing ${command}`);
      assert.match(result.stderr, new RegExp(diagnostic));
    });
  }
});

// contract_id: contract.ci-github-toolchain-verifier.processing
// integration_id: ci-github-toolchain-script
test('requires an exact version for every selected command', () => withToolchain((bin) => {
  // Arrange
  const missingVersion = { CI_GH_VERSION: '' };
  // Act
  const missing = run(bin, 'gh-jq', missingVersion);
  // Assert
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /gh-version-required/);

  // Arrange
  const mismatchedVersion = { CI_JQ_VERSION: '1.6' };
  // Act
  const mismatch = run(bin, 'jq-sha256', mismatchedVersion);
  // Assert
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /jq-version-mismatch: expected=1.6 actual=1.7/);
}));
