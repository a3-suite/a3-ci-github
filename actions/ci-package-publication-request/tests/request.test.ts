import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test, vi, expect } from 'vitest';
import { createRequest, verifyRequest } from '../src/request.js';

describe('ci-package-publication-request-source', () => {
  // integration_id: ci-package-publication-request-source
  // contract_id: contract.ci-package-publication-request.outputs
  test('creates and verifies a request bound to source SHA', (t) => {
    // Arrange
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-package-request-'));
    t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
    const requestPath = path.join(root, 'request.json');
    const fields = { sourceSha: 'a'.repeat(40), version: '1.2.3', targetIdentity: 'npm:pkg', languageProfile: 'node', toolchain: '22.20.0' };
    createRequest(requestPath, fields);

    // Act
    const result = verifyRequest(requestPath, fields.sourceSha);

    // Assert
    expect(result).toStrictEqual(fields);

    // Arrange
    const saved = fs.readFileSync(requestPath, 'utf8');
    // Act
    const replay = () => createRequest(requestPath, { ...fields, version: '9.9.9' });
    // Assert
    expect(replay).toThrow(/EEXIST/);
    expect(fs.readFileSync(requestPath, 'utf8')).toBe(saved);

    // Arrange
    const collision = path.join(root, 'collision.json');
    const write = fs.writeFileSync;
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, bytes, options) => {
      if (String(file) === collision) write(file, 'concurrent evidence');
      return write(file, bytes, options);
    });
    // Act
    const create = () => createRequest(collision, fields);
    // Assert
    try {
      expect(create).toThrow(/EEXIST/);
    } finally {
      spy.mockRestore();
    }
    expect(fs.readFileSync(collision, 'utf8')).toBe('concurrent evidence');
  });

  // integration_id: ci-package-publication-request-source
  test('rejects a request not bound to the expected source SHA', () => {
    // Arrange
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-package-request-'));
    const requestPath = path.join(root, 'request.json');
    createRequest(requestPath, { sourceSha: 'a'.repeat(40), version: '1', targetIdentity: 'pkg', languageProfile: 'node', toolchain: '22' });
    let failure: unknown;

    // Act
    try {
      verifyRequest(requestPath, 'b'.repeat(40));
    } catch (error) {
      failure = error;
    }

    // Assert
    expect(String(failure)).toMatch(/source-sha-mismatch/);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
