import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateHandoffDescriptor, validateHandoffIntegrity } from '../src/integrity.js';

// integration_id: ci-handoff-integrity-source
test('validates descriptor, manifest, and artifact digest', () => {
  // Arrange
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a3-handoff-'));
  const artifact = 'payload';
  fs.writeFileSync(path.join(root, 'artifact.bin'), artifact);
  const digest = crypto.createHash('sha256').update(artifact).digest('hex');
  const manifest = JSON.stringify([{ path: 'artifact.bin', sha256: digest }]);
  fs.writeFileSync(path.join(root, 'manifest.json'), manifest);
  fs.writeFileSync(path.join(root, 'handoff.json'), JSON.stringify({ schema: 'ci.handoff.v1', source_sha: 'abc', version: '1.0.0', target_identity: 'linux', manifest: 'manifest.json' }));
  // Act
  const result = validateHandoffIntegrity(root, 'handoff.json', { sourceSha: 'abc', version: '1.0.0', targetIdentity: 'linux' });
  // Assert
  assert.equal(result.entries, 1);
  assert.equal(result.manifest, 'manifest.json');
});

// integration_id: ci-handoff-integrity-source
test('rejects traversal descriptors', () => {
  // Arrange
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a3-handoff-'));
  let failure: unknown;
  // Act
  try { validateHandoffIntegrity(root, '../handoff.json', { sourceSha: 'x', version: '1', targetIdentity: 'x' }); } catch (error) { failure = error; }
  // Assert
  assert.match(String(failure), /handoff-descriptor-traversal-rejected/);
});

// integration_id: ci-handoff-integrity-source
test('rejects unsafe descriptor paths', () => {
  // Arrange
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a3-handoff-paths-'));
  const cases = [
    ['', /invalid-handoff-descriptor/],
    ['handoff\n.json', /invalid-handoff-descriptor/],
    ['/handoff.json', /must-be-relative/],
    ['nested\\handoff.json', /must-be-relative/],
    ['./handoff.json', /traversal-rejected/],
    ['nested//handoff.json', /traversal-rejected/],
  ] as const;
  const failures: unknown[] = [];

  // Act
  for (const [descriptor] of cases) {
    try { validateHandoffDescriptor(root, descriptor); } catch (error) { failures.push(error); }
  }

  // Assert
  assert.equal(failures.length, cases.length);
  failures.forEach((failure, index) => assert.match(String(failure), cases[index][1]));
  fs.rmSync(root, { recursive: true, force: true });
});

// integration_id: ci-handoff-integrity-source
test('rejects malformed handoff content', () => {
  // Arrange
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a3-handoff-content-'));
  const artifact = 'payload';
  const digest = crypto.createHash('sha256').update(artifact).digest('hex');
  fs.writeFileSync(path.join(root, 'artifact.bin'), artifact);
  const validDescriptor = { schema: 'ci.handoff.v1', source_sha: 'abc', version: '1.0.0', target_identity: 'linux', manifest: 'manifest.json' };
  const validManifest = [{ path: 'artifact.bin', sha256: digest }];
  const cases: [unknown, unknown, RegExp][] = [
    ['{', validManifest, /descriptor-json-invalid/],
    [{ ...validDescriptor, schema: 'other' }, validManifest, /descriptor-schema-invalid/],
    [{ ...validDescriptor, source_sha: '' }, validManifest, /source-sha-invalid/],
    [{ ...validDescriptor, version: '' }, validManifest, /version-invalid/],
    [{ ...validDescriptor, target_identity: '' }, validManifest, /target-identity-invalid/],
    [{ ...validDescriptor, manifest: '' }, validManifest, /manifest-invalid/],
    [validDescriptor, '{', /manifest-json-invalid/],
    [validDescriptor, [], /manifest-invalid/],
    [validDescriptor, [null], /manifest-entry-invalid/],
    [validDescriptor, [{ path: '', sha256: digest }], /manifest-path-invalid/],
    [validDescriptor, [{ path: 'artifact.bin', sha256: 'a' }], /manifest-digest-invalid/],
    [validDescriptor, [...validManifest, ...validManifest], /duplicate-path/],
    [validDescriptor, [{ path: 'artifact.bin', sha256: 'a'.repeat(64) }], /checksum-mismatch/],
  ];
  const failures: unknown[] = [];

  // Act
  for (const [descriptor, manifest] of cases) {
    fs.writeFileSync(path.join(root, 'handoff.json'), typeof descriptor === 'string' ? descriptor : JSON.stringify(descriptor));
    fs.writeFileSync(path.join(root, 'manifest.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
    try { validateHandoffIntegrity(root, 'handoff.json', { sourceSha: 'abc', version: '1.0.0', targetIdentity: 'linux' }); } catch (error) { failures.push(error); }
  }

  // Assert
  assert.equal(failures.length, cases.length);
  failures.forEach((failure, index) => assert.match(String(failure), cases[index][2]));
  fs.rmSync(root, { recursive: true, force: true });
});
