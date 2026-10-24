import fs from 'node:fs';
import path from 'node:path';
import { describe, test, expect } from 'vitest';
import { fixture, bundle as runEntrypoint } from './fixtures';

import { fixture as standardFixture, archiveName, runDistributedAction } from './standard-installer-fixtures';

import { actionEntrypointArguments } from '../../../tests/support/action-entrypoint';

describe.each(['source', 'dist'] as const)('%s entrypoint', (surface) => {
  const entrypointArgs = actionEntrypointArguments(path.resolve(__dirname, '..'), surface);
const bundle = (f: ReturnType<typeof fixture>, changes: Record<string, string> = {}) => runEntrypoint(f, changes, entrypointArgs);
// contract_id: contract.ci-release-supplemental-asset.outputs
// evidence_role: contract
// flow_id: supplemental-phase-entrypoint
// test_level: e2e
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
  for (const operation of ['build-platform', 'assemble']) {
    const f = fixture(t, 'echo secret-owner-diagnostic >&2\nexit 23');
    const result = bundle(f, { INPUT_OPERATION: operation, 'INPUT_SUPPLEMENTAL-BUILD-ROOT': operation === 'assemble' ? 'supplemental build' : '' });
    expect(result.status).toBe(1);
    expect(String(result.stderr)).toMatch(/owner-adapter-failed/);
    const diagnostic = JSON.parse(String(result.stderr).split('\n').find((line: string) => line.startsWith('owner-adapter-failed:'))!.slice('owner-adapter-failed:'.length));
    expect(diagnostic.operation).toBe('owner-adapter');
    expect(diagnostic.phase).toBe(operation);
    expect(diagnostic['exit-status']).toBe(23);
    const evidence = JSON.parse(String(result.stderr).split('\n').find((line: string) => line.startsWith('ci-failure-diagnostic:'))!.slice('ci-failure-diagnostic:'.length));
    expect(evidence.classification.stage).toBe('owner-adapter-execution');
    expect(evidence.comparison['exit-status']).toBe(23);
    expect(evidence['execution-state'].write).toBe('supplemental-output-may-be-partial');
    expect(diagnostic['sanitized-reason']).toBe('process-failed');
    expect(String(result.stderr)).not.toMatch(/secret-owner-diagnostic/);
    expect(fs.readFileSync(f.outputPath, 'utf8')).toBe('');
  }
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

// contract_id: contract.ci-release-supplemental-asset.outputs
// evidence_role: contract
// flow_id: supplemental-safe-diagnostics
// test_level: e2e
test('supplemental entrypoint rejects the old Windows entry name with expected-name diagnostics', (t) => {
  // Arrange
  for (const operation of ['build-platform', 'assemble']) {
    const f = standardFixture(t, 'native-offline-dry-run-v1', 'install-windows-x86_64.ps1');
    const options = { ...f.options, operation };
    if (operation === 'assemble') {
      fs.mkdirSync(path.join(f.root, 'supplemental-download'));
      fs.writeFileSync(path.join(f.root, 'supplemental-download/input'), 'unverified');
      Object.assign(options, { supplementalBuildRoot: 'supplemental-download' });
    }
    // Act
    const { result, output } = runDistributedAction(f, options, entrypointArgs);
    // Assert
    expect(result.status).toBe(1);
    const line = result.stderr.split('\n').find((entry: string) => entry.startsWith('standard-installer-failed:'))!;
    const diagnostic = JSON.parse(line.slice('standard-installer-failed:'.length));
    expect(diagnostic.phase).toBe(operation);
    expect(diagnostic['sanitized-reason']).toBe('installer-windows-entry-name-invalid');
    expect(diagnostic.comparison.expected).toEqual(['install.ps1']);
    expect(fs.readFileSync(output, 'utf8')).toBe('');
    expect(fs.existsSync(path.join(f.root, options.outputDirectory))).toBe(false);
  }
});

// flow_id: supplemental-safe-diagnostics
// test_level: e2e
test('supplemental entrypoint preserves safe standard installer diagnostics', (t) => {
  const f = standardFixture(t);
  fs.writeFileSync(path.join(f.root, 'standard', `${archiveName}.sha256`), 'synthetic-secret');
  const { result, output } = runDistributedAction(f, f.options, entrypointArgs);
  expect(result.status).toBe(1);
  expect(result.stderr).not.toContain('synthetic-secret');
  const diagnostic = JSON.parse(result.stderr.split('\n').find((line: string) => line.startsWith('standard-installer-failed:'))!.slice('standard-installer-failed:'.length));
  expect(diagnostic.operation).toBe('standard-installer');
  expect(diagnostic.phase).toBe('build-platform');
  expect(diagnostic['sanitized-reason']).toBe('installer-artifact-checksum-invalid');
  expect(diagnostic['exit-status']).toBe(1);
  expect(fs.readFileSync(output, 'utf8')).toBe('');
  expect(fs.existsSync(path.join(f.root, 'platform-output/platform-record.json'))).toBe(false);
});

// contract_id: contract.ci-release-supplemental-asset.assembly
// flow_id: supplemental-phase-entrypoint
test('supplemental entrypoint assembles an asset release from empty build roots and fails with build input', (t) => {
  // Arrange
  const assetRelease = (sub: Parameters<typeof fixture>[0]) => {
    const f = fixture(sub);
    f.configure({ CI_RELEASE_IMPLEMENTATION: 'asset-release', CI_PLATFORM_MANIFEST: '__unset__' },
      { language_profile: null, toolchain_version: null, platform_manifest: null, platform_manifest_sha256: null } as unknown as Record<string, string>);
    for (const directory of ['standard build', 'supplemental build']) fs.rmSync(path.join(f.root, directory, 'input'));
    return f;
  };
  const valid = assetRelease(t);
  const withBuild = assetRelease(t);
  fs.writeFileSync(path.join(withBuild.root, 'standard build/input'), 'product build');
  const assemble = { INPUT_OPERATION: 'assemble', 'INPUT_SUPPLEMENTAL-BUILD-ROOT': 'supplemental build' };
  // Act
  const result = bundle(valid, assemble);
  const rejected = bundle(withBuild, assemble);
  // Assert
  expect(result.status, String(result.stderr)).toBe(0);
  expect(fs.readFileSync(valid.outputPath, 'utf8')).toBe('status=success\noutput-directory=new output\n');
  expect(rejected.status).toBe(1);
  expect(String(rejected.stderr)).toMatch(/unexpected-build-input/);
  expect(fs.readFileSync(withBuild.outputPath, 'utf8')).toBe('');
  expect(fs.existsSync(path.join(withBuild.root, 'new output'))).toBe(false);
});

});
