import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');

// evidence_role: supplemental
// test_level: integration
// integration_id: repository-cli-specification
test('CLI specification indexes only repository-owned public entrypoints', () => {
  // Arrange
  const manifestPath = 'sdd/dsl/specs/cli/cli-command-manifest.sdd.yml';
  // Act
  const manifest = read(manifestPath);
  const externalCommandPresent = existsSync(path.join(root, 'sdd/dsl/specs/cli/commands/sdd-check'));
  // Assert
  for (const pattern of [
    /id: validate-ci-preset/,
    /id: generate-ci-asset-lock/,
    /id: materialize-adapter-bundle/,
    /id: manage-ci-distribution/,
    /id: generate-ci-distribution-release/,
  ]) {
    assert.match(manifest, pattern);
  }
  assert.doesNotMatch(manifest, /sdd-check/);
  assert.equal(externalCommandPresent, false);
});

// evidence_role: supplemental
// test_level: integration
// integration_id: repository-cli-specification
test('CLI option vocabulary matches public parser flags', () => {
  // Arrange
  const vocabularyPath = 'sdd/dsl/specs/cli/cli-option-vocabulary.sdd.yml';
  // Act
  const vocabulary = read(vocabularyPath);
  const implementations = [
    read('runtime/preset/run-validate-ci-preset.mjs'),
    read('runtime/preset/generate-ci-asset-lock.ts'),
    read('runtime/adapter/materialize-adapter-bundle.ts'),
    read('runtime/distribution/fetch-a3-ci-github.mjs'),
    read('runtime/distribution/generate-distribution-release.ts'),
  ].join('\n');
  const declared = [...vocabulary.matchAll(/^\s+long:\s+(--\S+)$/gm)].map((match) => match[1]);
  // Assert
  assert.deepEqual(declared.sort(), [
    '--approve', '--asset', '--audit-mode', '--bundle', '--inventory', '--manifest',
    '--manifest-url', '--output', '--output-directory', '--plan', '--preset', '--release-tag',
    '--repo-root', '--repository-root', '--skill-collection-root', '--source-revision',
    '--source-root', '--target-root', '--transaction',
  ].sort());
  for (const flag of declared) assert.equal(implementations.includes(`'${flag}'`), true, flag);
  assert.match(vocabulary, /resolving a relative path from the process working directory/);
});

// evidence_role: supplemental
// test_level: integration
// integration_id: repository-cli-specification
test('validate preset usage keeps read-only output invalid', () => {
  // Arrange
  const specificationPath = 'sdd/dsl/specs/cli/commands/validate-ci-preset/cli-command.sdd.yml';
  // Act
  const specification = read(specificationPath);
  const [readOnly, remediation] = specification.split('    - id: remediation');
  // Assert
  assert.doesNotMatch(readOnly, /option_id: output/);
  assert.match(remediation, /option_id: output/);
  assert.match(specification, /--audit-mode read-only[^\n]*\n      - node[^\n]*--audit-mode remediation[^\n]*--output/);
});
