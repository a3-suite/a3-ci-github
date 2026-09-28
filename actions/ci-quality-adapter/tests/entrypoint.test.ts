import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const descriptor = (boundary = 'read-only'): string => `schemaVersion: "1"\nkind: ci-adapter-bundle\nid: node-quality\ncontract: quality-scripts\nlanguageProfiles: [node]\nprovider: github\nexecutionBoundary: ${boundary}\nsourceCheckout: fixed-source\ncopyable: true\nowner: ci\nassets: []\nprojectSettings:\n  requiredFiles: []\n  requiredScripts: []\n  requiredEnvironmentPaths: []\ntoolchain:\n  versionEnv: CI_TOOLCHAIN_VERSION\n  verify:\n    command: node\n    args: [--version]\npreparation:\n  - id: prepare\n    command: node\n    args: [-e, "process.exit(0)"]\ncommands:\n  - id: test\n    command: node\n    args: [-e, "process.exit(0)"]\n`;

const runAction = (root: string, content: string) => {
  const descriptor = path.join(root, 'adapter.yml');
  const output = path.join(root, 'output');
  const resultPath = path.join(root, 'result.json');
  fs.writeFileSync(descriptor, content);
  fs.writeFileSync(output, '');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output, 'INPUT_BUNDLE-PATH': descriptor, 'INPUT_SOURCE-ROOT': root, 'INPUT_RESULT-PATH': resultPath, 'INPUT_TOOLCHAIN-VERSION': process.version.slice(1), 'INPUT_REQUIRE-TRUSTED-PROJECT-SCRIPTS': 'false' } as Record<string, string>;
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../dist/index.js')], { env, encoding: 'utf8' });
  return { result, output, resultPath };
};

// contract_id: contract.ci-quality-adapter.outputs
// integration_id: ci-quality-adapter-contract-entrypoint
test('bundled entrypoint emits status and result path', () => {
  // Arrange
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-adapter-entry-'));

  // Act
  const run = runAction(root, descriptor());

  // Assert
  assert.equal(run.result.status, 0);
  assert.equal(JSON.parse(fs.readFileSync(run.resultPath, 'utf8')).status, 'success');
  assert.match(fs.readFileSync(run.output, 'utf8'), /status.*success/s);
  fs.rmSync(root, { recursive: true, force: true });
});

// integration_id: ci-quality-adapter-entrypoint-regression
test('bundled entrypoint rejects a non-read-only descriptor', () => {
  // Arrange
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-adapter-entry-'));

  // Act
  const run = runAction(root, descriptor('trusted-control'));
  const result = run.result;

  // Assert
  assert.notEqual(result.status, 0);
  assert.match(fs.readFileSync(run.output, 'utf8'), /status.*failed/s);
  assert.match(`${result.stdout}${result.stderr}`, /quality-adapter-execution-boundary-invalid/);
  fs.rmSync(root, { recursive: true, force: true });
});
