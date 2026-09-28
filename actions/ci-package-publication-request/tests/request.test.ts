import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequest, verifyRequest } from '../src/request.js';

// integration_id: ci-package-publication-request-source
test('creates and verifies a request bound to source SHA', () => {
  // Arrange
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-package-request-'));
  const requestPath = path.join(root, 'request.json');
  const fields = { sourceSha: 'a'.repeat(40), version: '1.2.3', targetIdentity: 'npm:pkg', languageProfile: 'node', toolchain: '22.20.0' };
  createRequest(requestPath, fields);

  // Act
  const result = verifyRequest(requestPath, fields.sourceSha);

  // Assert
  assert.deepEqual(result, fields);
  fs.rmSync(root, { recursive: true, force: true });
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
  assert.match(String(failure), /source-sha-mismatch/);
  fs.rmSync(root, { recursive: true, force: true });
});
