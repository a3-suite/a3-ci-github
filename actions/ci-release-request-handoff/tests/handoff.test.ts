import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test, vi, expect } from 'vitest';
import { writeReleaseRequestHandoff } from '../src/handoff.js';

const base = { tagSourceSha: 'a'.repeat(40), tagObjectSha: 'b'.repeat(40), requestRunId: '42', requestActor: 'release-operator' };

describe('ci-release-request-handoff-source', () => {
  // integration_id: ci-release-request-handoff-source
  // contract_id: contract.ci-release-request-handoff.outputs
  test('writes tag request without release notes', (t) => {
    // Arrange
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-request-handoff-'));
    t.onTestFinished(() => fs.rmSync(outputDirectory, { recursive: true, force: true }));
    const input = { ...base, outputDirectory, githubRef: 'refs/tags/v1.2.3', githubRefName: 'v1.2.3' };
    // Act
    const result = writeReleaseRequestHandoff(input);
    const request = JSON.parse(fs.readFileSync(result.requestPath, 'utf8'));
    // Assert
    expect(request.event).toBe('tag');
    expect(fs.existsSync(result.requestDigestPath)).toBeTruthy();

    // Arrange
    const files = [result.requestPath, result.requestDigestPath];
    const saved = files.map((file) => fs.readFileSync(file, 'utf8'));
    // Act
    const replay = () => writeReleaseRequestHandoff({ ...input, tagSourceSha: 'c'.repeat(40) });
    // Assert
    expect(replay).toThrow(/already-exists|EEXIST/);
    expect(files.map((file) => fs.readFileSync(file, 'utf8'))).toStrictEqual(saved);

    for (const filename of ['release-request.json', 'release-request.json.sha256']) {
      // Arrange
      const partial = path.join(outputDirectory, `existing-${filename}`);
      fs.mkdirSync(partial);
      fs.writeFileSync(path.join(partial, filename), 'existing evidence');
      // Act
      const create = () => writeReleaseRequestHandoff({ ...input, outputDirectory: partial });
      // Assert
      expect(create).toThrow(/already-exists|EEXIST/);
      expect(fs.readdirSync(partial)).toStrictEqual([filename]);
      expect(fs.readFileSync(path.join(partial, filename), 'utf8')).toBe('existing evidence');
    }

    // Arrange
    const collision = path.join(outputDirectory, 'collision');
    const digestPath = path.join(collision, 'release-request.json.sha256');
    const write = fs.writeFileSync;
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, bytes, options) => {
      if (String(file) === digestPath) write(file, 'concurrent evidence');
      return write(file, bytes, options);
    });
    // Act
    const create = () => writeReleaseRequestHandoff({ ...input, outputDirectory: collision });
    // Assert
    try {
      expect(create).toThrow(/EEXIST/);
    } finally {
      spy.mockRestore();
    }
    expect(fs.readFileSync(digestPath, 'utf8')).toBe('concurrent evidence');
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
    expect(String(failure)).toMatch(/github-tag-ref-mismatch/);
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  });
});
