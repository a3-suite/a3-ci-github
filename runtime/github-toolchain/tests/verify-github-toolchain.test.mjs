import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, describe, expect } from 'vitest';
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
    for (const name of ['awk', 'bash', 'env', 'sed']) {
      const resolved = spawnSync('sh', ['-c', 'command -v "$1"', 'sh', name], { encoding: 'utf8' });
      expect(resolved.status, `required shell tool: ${name}`).toBe(0);
      const target = resolved.stdout.trim();
      expect(path.isAbsolute(target), `required shell tool: ${name}`).toBe(true);
      symlinkSync(target, path.join(bin, name));
    }
    callback(bin);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
};

const runWithArguments = (bin, args, overrides = {}) => spawnSync(path.join(bin, 'bash'), [script, ...args], {
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
const run = (bin, mode, overrides = {}) => runWithArguments(bin, [mode], overrides);
const diagnosticOf = (stderr) => {
  const line = stderr.split('\n').find((value) => value.startsWith('ci-failure-diagnostic:'));
  return JSON.parse(line?.slice('ci-failure-diagnostic:'.length) ?? '{}');
};

describe("contract.ci-github-toolchain-verifier.processing", () => {
  describe("ci-github-toolchain-script", () => {
    // contract_id: contract.ci-github-toolchain-verifier.processing
    // flow_id: ci-github-toolchain-script
    test('accepts every supported verification mode', () => withToolchain((bin) => {
      // Arrange
      const modes = ['jq', 'gh-jq', 'jq-sha256', 'gh-jq-sha256'];
      // Act
      const results = modes.map((mode) => run(bin, mode));
      // Assert
      results.forEach((result, index) => expect(result.status, modes[index]).toBe(0));
    }));

    // contract_id: contract.ci-github-toolchain-verifier.processing
    // flow_id: ci-github-toolchain-script
    test('rejects an unsupported mode', () => withToolchain((bin) => {
      // Arrange
      const mode = 'all';
      // Act
      const result = run(bin, mode);
      // Assert
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/github-toolchain-mode-invalid/);
      expect(diagnosticOf(result.stderr).classification.stage).toBe('mode-validation');
    }));

    // contract_id: contract.ci-github-toolchain-verifier.processing
    // flow_id: ci-github-toolchain-script
    test('rejects a wrong number of arguments', () => withToolchain((bin) => {
      for (const args of [[], ['jq', 'gh-jq']]) {
        // Arrange
        // Act
        const result = runWithArguments(bin, args);
        // Assert
        expect(result.status, `${args.length} arguments`).not.toBe(0);
        expect(result.stderr).toMatch(/usage: verify-github-toolchain\.sh/);
        expect(diagnosticOf(result.stderr).classification.stage).toBe('input-validation');
      }
    }));

    // contract_id: contract.ci-github-toolchain-verifier.processing
    // flow_id: ci-github-toolchain-script
    test('rejects a failed version response', () => withToolchain((bin) => {
      // Arrange
      writeFileSync(path.join(bin, 'gh'), "#!/usr/bin/env bash\necho 'gh: version unavailable' >&2\nexit 3\n");
      // Act
      const result = run(bin, 'gh-jq');
      // Assert
      expect(result.status).not.toBe(0);
      expect(diagnosticOf(result.stderr)).toMatchObject({
        classification: { subject: 'ci-github-toolchain-verifier', stage: 'tool-version-validation' },
        'execution-state': { exit: result.status },
      });
    }));

    // contract_id: contract.ci-github-toolchain-verifier.processing
    // flow_id: ci-github-toolchain-script
    test('rejects an unavailable selected command', () => {
      const cases = [
        ['jq', 'jq', 'jq-required', 'jq-availability'],
        ['gh-jq', 'gh', 'github-cli-required', 'tool-version-validation'],
        ['jq-sha256', 'sha256sum', 'sha256sum-required', 'tool-version-validation'],
      ];
      for (const [mode, command, diagnostic, stage] of cases) {
        // Arrange
        withToolchain((bin) => {
          rmSync(path.join(bin, command));

          // Act
          const result = run(bin, mode);

          // Assert
          expect(result.status, `${mode} should reject a missing ${command}`).toBe(1);
          expect(result.stderr).toMatch(new RegExp(diagnostic));
          expect(diagnosticOf(result.stderr).classification.stage).toBe(stage);
        });
      }
    });

    // contract_id: contract.ci-github-toolchain-verifier.processing
    // flow_id: ci-github-toolchain-script
    test('requires an exact version for every selected command', () => withToolchain((bin) => {
      // Arrange
      const missingVersion = { CI_GH_VERSION: '' };
      // Act
      const missing = run(bin, 'gh-jq', missingVersion);
      // Assert
      expect(missing.status).toBe(1);
      expect(missing.stderr).toMatch(/gh-version-required/);
      expect(diagnosticOf(missing.stderr).classification.stage).toBe('tool-version-validation');

      // Arrange
      const mismatchedVersion = { CI_JQ_VERSION: '1.6' };
      // Act
      const mismatch = run(bin, 'jq-sha256', mismatchedVersion);
      // Assert
      expect(mismatch.status).toBe(1);
      expect(mismatch.stderr).toMatch(/jq-version-mismatch: expected=1.6 actual=1.7/);
      expect(diagnosticOf(mismatch.stderr)).toMatchObject({
        classification: { subject: 'ci-github-toolchain-verifier', stage: 'tool-version-validation' },
        comparison: { field: 'jq-version', expected: '1.6', observed: '1.7' },
      });
    }));
  });
});
