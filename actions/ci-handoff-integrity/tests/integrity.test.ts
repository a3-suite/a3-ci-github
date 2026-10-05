import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test, vi, expect } from 'vitest';
import { validateHandoffDescriptor, validateHandoffIntegrity } from '../src/integrity.js';

describe('ci-handoff-integrity-source', () => {
  // integration_id: ci-handoff-integrity-source
  test('validates descriptor, manifest, and artifact digest', (t) => {
    // Arrange
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a3-handoff-'));
    t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
    const artifact = 'payload';
    fs.writeFileSync(path.join(root, 'artifact.bin'), artifact);
    const digest = crypto.createHash('sha256').update(artifact).digest('hex');
    const manifest = JSON.stringify([{ path: 'artifact.bin', sha256: digest }]);
    fs.writeFileSync(path.join(root, 'manifest.json'), manifest);
    fs.writeFileSync(path.join(root, 'handoff.json'), JSON.stringify({ schema: 'ci.handoff.v1', source_sha: 'abc', version: '1.0.0', target_identity: 'linux', manifest: 'manifest.json' }));
    // Act
    const result = validateHandoffIntegrity(root, 'handoff.json', { sourceSha: 'abc', version: '1.0.0', targetIdentity: 'linux' });
    // Assert
    expect(result.entries).toBe(1);
    expect(result.manifest).toBe('manifest.json');
    expect(result.manifestDigest).toBe(crypto.createHash('sha256').update(manifest).digest('hex'));

    // Arrange
    const artifactPath = fs.realpathSync(path.join(root, 'artifact.bin'));
    const manifestPath = path.join(root, 'manifest.json');
    const changedManifest = JSON.stringify([{ path: 'artifact.bin', sha256: '0'.repeat(64) }]);
    const read = fs.readFileSync;
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((file, options) => {
      if (String(file) === artifactPath) fs.writeFileSync(manifestPath, changedManifest);
      return read(file, options);
    });
    // Act
    const validate = () => validateHandoffIntegrity(root, 'handoff.json', { sourceSha: 'abc', version: '1.0.0', targetIdentity: 'linux' });
    // Assert
    try {
      expect(validate).toThrow(/handoff-manifest-checksum-mismatch/);
    } finally {
      spy.mockRestore();
    }
    expect(fs.readFileSync(manifestPath, 'utf8')).toBe(changedManifest);
  });

  // integration_id: ci-handoff-integrity-source
  test('rejects traversal descriptors', () => {
    // Arrange
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a3-handoff-'));
    let failure: unknown;
    // Act
    try { validateHandoffIntegrity(root, '../handoff.json', { sourceSha: 'x', version: '1', targetIdentity: 'x' }); } catch (error) { failure = error; }
    // Assert
    expect(String(failure)).toMatch(/handoff-descriptor-traversal-rejected/);
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
    expect(failures.length).toBe(cases.length);
    failures.forEach((failure, index) => expect(String(failure)).toMatch(cases[index][1]));
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
    expect(failures.length).toBe(cases.length);
    failures.forEach((failure, index) => expect(String(failure)).toMatch(cases[index][2]));
    fs.rmSync(root, { recursive: true, force: true });
  });
});
