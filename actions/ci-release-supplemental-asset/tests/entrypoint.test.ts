import fs from 'node:fs';
import path from 'node:path';
import { describe, test, expect } from 'vitest';
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
    expect(result.status, String(result.stderr)).toBe(0);
    expect(fs.readFileSync(f.outputPath, 'utf8')).toBe('status=success\noutput-directory=new output\n');
    expect(fs.readFileSync(path.join(f.root, 'new output/arguments'), 'utf8')).toBe([operation, 'authority.json', 'snapshot.json', 'standard build', ...(operation === 'assemble' ? ['supplemental build'] : []), 'new output', ''].join('\n'));
  });
}

test('supplemental entrypoint rejects invalid binding before owner execution', (t) => {
  const f = fixture(t);
  f.configure({ CI_SUPPLEMENTAL_RELEASE_ASSET_ENABLED: 'false' });
  const result = bundle(f);
  expect(result.status).toBe(1);
  expect(String(result.stderr)).toMatch(/supplemental-asset-not-selected/);
  expect(fs.readFileSync(f.outputPath, 'utf8')).toBe('');
  expect(fs.existsSync(path.join(f.root, 'new output'))).toBe(false);
});

test('supplemental entrypoint rejects injected output before owner execution', (t) => {
  const f = fixture(t);
  const cases: Record<string, string>[] = [{ 'INPUT_OUTPUT-DIRECTORY': 'new output\nstatus=success' }, { GITHUB_OUTPUT: `${f.outputPath}\nstatus=success` }];
  for (const changes of cases) {
    const result = bundle(f, changes);
    expect(result.status).toBe(1);
    expect(fs.readFileSync(f.outputPath, 'utf8')).toBe('');
    expect(fs.existsSync(path.join(f.root, 'new output'))).toBe(false);
  }
});

test('supplemental entrypoint propagates owner failure without owner diagnostics', (t) => {
  const f = fixture(t, 'echo secret-owner-diagnostic >&2\nexit 23');
  const result = bundle(f);
  expect(result.status).toBe(1);
  expect(String(result.stderr)).toMatch(/owner-adapter-failed/);
  expect(String(result.stderr)).not.toMatch(/secret-owner-diagnostic/);
  expect(fs.readFileSync(f.outputPath, 'utf8')).toBe('');
});

test('supplemental entrypoint rejects mutated standard inputs and retains partial output', (t) => {
  const f = fixture(t, 'mkdir -p -- "${!#}"\nprintf data > "${!#}/asset"\nprintf changed > "$4/input"');
  const result = bundle(f);
  expect(result.status).toBe(1);
  expect(String(result.stderr)).toMatch(/build-input-mutated/);
  expect(fs.readFileSync(f.outputPath, 'utf8')).toBe('');
  expect(fs.readFileSync(path.join(f.root, 'new output/asset'), 'utf8')).toBe('data');
  const retry = bundle(f);
  expect(retry.status).toBe(1);
  expect(String(retry.stderr)).toMatch(/output-already-exists/);
});

});
