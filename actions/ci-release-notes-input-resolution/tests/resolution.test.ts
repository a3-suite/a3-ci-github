import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test, expect } from 'vitest';
import { resolveReleaseNotesInput } from '../src/resolution.js';

const setup = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-notes-resolution-'));
  const source = path.join(root, 'source');
  const output = path.join(root, 'output');
  fs.mkdirSync(source);
  return { root, source, output };
};

describe('ci-release-notes-input-resolution-source', () => {
  // integration_id: ci-release-notes-input-resolution-source
  test('copies external notes handoff', () => {
    // Arrange
    const paths = setup();
    fs.writeFileSync(path.join(paths.source, 'release-notes.json'), '{}');
    fs.writeFileSync(path.join(paths.source, 'release-notes-approval.json'), '{}');
    // Act
    const result = resolveReleaseNotesInput({ inputHandoffDirectory: paths.source, outputDirectory: paths.output });
    // Assert
    expect(result.releaseNotesPath && fs.existsSync(result.releaseNotesPath)).toBeTruthy();
    fs.rmSync(paths.root, { recursive: true, force: true });
  });

  // integration_id: ci-release-notes-input-resolution-source
  test('rejects an existing normalized handoff', () => {
    // Arrange
    const paths = setup();
    fs.mkdirSync(paths.output);
    fs.writeFileSync(path.join(paths.output, 'release-notes.json'), '{}');
    fs.writeFileSync(path.join(paths.output, 'release-notes-approval.json'), '{}');
    // Act
    let failure: unknown;
    try {
      resolveReleaseNotesInput({ inputHandoffDirectory: paths.source, outputDirectory: paths.output });
    } catch (error) {
      failure = error;
    }
    // Assert
    expect(String(failure)).toMatch(/release-notes-input-already-present/);
    fs.rmSync(paths.root, { recursive: true, force: true });
  });
});
