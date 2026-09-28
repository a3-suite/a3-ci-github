import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeReleaseRequestHandoff } from '../src/handoff.js';

const base = { tagSourceSha: 'a'.repeat(40), tagObjectSha: 'b'.repeat(40), requestRunId: '42', requestActor: 'release-operator' };

// integration_id: ci-release-request-handoff-source
test('writes tag request without release notes', () => {
  // Arrange
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-request-handoff-'));
  // Act
  const result = writeReleaseRequestHandoff({ ...base, outputDirectory, githubRef: 'refs/tags/v1.2.3', githubRefName: 'v1.2.3' });
  const request = JSON.parse(fs.readFileSync(result.requestPath, 'utf8'));
  // Assert
  assert.equal(request.event, 'tag');
  assert.ok(fs.existsSync(result.requestDigestPath));
  fs.rmSync(outputDirectory, { recursive: true, force: true });
});

// integration_id: ci-release-request-handoff-source
test('rejects a tag ref that does not match the tag name', () => {
  // Arrange
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-request-handoff-'));
  let failure: unknown;
  // Act
  try {
    writeReleaseRequestHandoff({ ...base, outputDirectory, githubRef: 'refs/tags/v2.0.0', githubRefName: 'v1.2.3' });
  } catch (error) {
    failure = error;
  }
  // Assert
  assert.match(String(failure), /github-tag-ref-mismatch/);
  fs.rmSync(outputDirectory, { recursive: true, force: true });
});
