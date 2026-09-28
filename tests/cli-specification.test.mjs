import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');

// integration_id: repository-cli-specification
test('CLI specification indexes only repository-owned public entrypoints', () => {
  const manifest = read('sdd/dsl/specs/cli/cli-command-manifest.sdd.yml');
  for (const pattern of [/id: validate-ci-preset/, /id: generate-ci-asset-lock/, /id: materialize-adapter-bundle/]) {
    assert.match(manifest, pattern);
  }
  assert.doesNotMatch(manifest, /sdd-check/);
  assert.equal(existsSync(path.join(root, 'sdd/dsl/specs/cli/commands/sdd-check')), false);
});

// integration_id: repository-cli-specification
test('CLI option vocabulary matches public parser flags', () => {
  const vocabulary = read('sdd/dsl/specs/cli/cli-option-vocabulary.sdd.yml');
  const implementations = [
    read('runtime/preset/run-validate-ci-preset.mjs'),
    read('runtime/preset/generate-ci-asset-lock.ts'),
    read('runtime/adapter/materialize-adapter-bundle.ts'),
  ].join('\n');
  const declared = [...vocabulary.matchAll(/^\s+long:\s+(--\S+)$/gm)].map((match) => match[1]);
  assert.deepEqual(declared.sort(), [
    '--audit-mode', '--bundle', '--inventory', '--output', '--preset', '--repo-root',
    '--skill-collection-root', '--source-revision', '--source-root', '--target-root',
  ].sort());
  for (const flag of declared) assert.equal(implementations.includes(`'${flag}'`), true, flag);
  assert.match(vocabulary, /resolving a relative path from the process working directory/);
});

// integration_id: repository-cli-specification
test('validate preset usage keeps read-only output invalid', () => {
  const specification = read('sdd/dsl/specs/cli/commands/validate-ci-preset/cli-command.sdd.yml');
  const [readOnly, remediation] = specification.split('    - id: remediation');
  assert.doesNotMatch(readOnly, /option_id: output/);
  assert.match(remediation, /option_id: output/);
  assert.match(specification, /--audit-mode read-only[^\n]*\n      - node[^\n]*--audit-mode remediation[^\n]*--output/);
});
