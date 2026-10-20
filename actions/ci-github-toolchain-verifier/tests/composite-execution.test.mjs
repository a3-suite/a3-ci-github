import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, describe, expect } from 'vitest';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const action = readFileSync(path.join(root, 'action.yml'), 'utf8');

const runBlock = () => {
  const match = action.match(/^      run: \|\n((?: {8}.*\n?)+)/m);
  expect(match, 'action.yml must contain a composite run block').toBeTruthy();
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

describe("contract.ci-github-toolchain-verifier.outputs", () => {
  describe("ci-github-toolchain-verifier-action", () => {
    // contract_id: contract.ci-github-toolchain-verifier.outputs
    // flow_id: ci-github-toolchain-verifier-action
    test('composite run exposes verified only after exact toolchain verification', () => withCompositeFixture((fixture) => {
      // Arrange
      const successInput = fixture;
      // Act
      const success = runComposite(successInput);
      // Assert
      expect(success.status, success.stderr).toBe(0);
      expect(readFileSync(fixture.output, 'utf8')).toBe('verified=true\n');

      // Arrange
      writeFileSync(fixture.output, '');
      // Act
      const failure = runComposite(fixture, { CI_JQ_VERSION: '1.6' });
      // Assert
      expect(failure.status).toBe(1);
      expect(failure.stderr).toMatch(/jq-version-mismatch/);
      expect(readFileSync(fixture.output, 'utf8')).toBe('');
    }));
  });
});
