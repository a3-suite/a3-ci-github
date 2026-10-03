import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'vitest';
import { fixture, bundle as runEntrypoint } from './fixtures';

import { actionEntrypointArguments } from '../../../tests/support/action-entrypoint';

describe.each(['source', 'dist'] as const)('%s entrypoint', (surface) => {
  const entrypointArgs = actionEntrypointArguments(path.resolve(__dirname, '..'), surface);
const bundle = (f: ReturnType<typeof fixture>, changes: Record<string, string> = {}) => runEntrypoint(f, changes, entrypointArgs);
// contract_id: contract.ci-release-supplemental-asset.outputs
// integration_id: supplemental-phase-entrypoint
for (const operation of ['build-platform', 'assemble']) {
  test(`supplemental entrypoint emits success for the v2 ${operation} phase`, (t) => {
    const f = fixture(t);
    const result = bundle(f, { INPUT_OPERATION: operation, 'INPUT_SUPPLEMENTAL-BUILD-ROOT': operation === 'assemble' ? 'supplemental build' : '' });
    assert.equal(result.status, 0, String(result.stderr));
    assert.equal(fs.readFileSync(f.outputPath, 'utf8'), 'status=success\noutput-directory=new output\n');
    assert.equal(fs.readFileSync(path.join(f.root, 'new output/arguments'), 'utf8'),
      [operation, 'authority.json', 'snapshot.json', 'standard build', ...(operation === 'assemble' ? ['supplemental build'] : []), 'new output', ''].join('\n'));
  });
}

test('supplemental entrypoint rejects invalid binding before owner execution', (t) => {
  const f = fixture(t);
  f.configure({ CI_SUPPLEMENTAL_RELEASE_ASSET_ENABLED: 'false' });
  const result = bundle(f);
  assert.equal(result.status, 1);
  assert.match(String(result.stderr), /supplemental-asset-not-selected/);
  assert.equal(fs.readFileSync(f.outputPath, 'utf8'), '');
  assert.equal(fs.existsSync(path.join(f.root, 'new output')), false);
});

test('supplemental entrypoint rejects injected output before owner execution', (t) => {
  const f = fixture(t);
  const cases: Record<string, string>[] = [{ 'INPUT_OUTPUT-DIRECTORY': 'new output\nstatus=success' }, { GITHUB_OUTPUT: `${f.outputPath}\nstatus=success` }];
  for (const changes of cases) {
    const result = bundle(f, changes);
    assert.equal(result.status, 1);
    assert.equal(fs.readFileSync(f.outputPath, 'utf8'), '');
    assert.equal(fs.existsSync(path.join(f.root, 'new output')), false);
  }
});

test('supplemental entrypoint propagates owner failure without owner diagnostics', (t) => {
  const f = fixture(t, 'echo secret-owner-diagnostic >&2\nexit 23');
  const result = bundle(f);
  assert.equal(result.status, 1);
  assert.match(String(result.stderr), /owner-adapter-failed/);
  assert.doesNotMatch(String(result.stderr), /secret-owner-diagnostic/);
  assert.equal(fs.readFileSync(f.outputPath, 'utf8'), '');
});

test('supplemental entrypoint rejects mutated standard inputs and retains partial output', (t) => {
  const f = fixture(t, 'mkdir -p -- "${!#}"\nprintf data > "${!#}/asset"\nprintf changed > "$4/input"');
  const result = bundle(f);
  assert.equal(result.status, 1);
  assert.match(String(result.stderr), /build-input-mutated/);
  assert.equal(fs.readFileSync(f.outputPath, 'utf8'), '');
  assert.equal(fs.readFileSync(path.join(f.root, 'new output/asset'), 'utf8'), 'data');
  const retry = bundle(f);
  assert.equal(retry.status, 1);
  assert.match(String(retry.stderr), /output-already-exists/);
});

});
