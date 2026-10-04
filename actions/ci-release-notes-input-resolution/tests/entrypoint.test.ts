import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';

import { actionEntrypointArguments } from '../../../tests/support/action-entrypoint';

describe.each(['source', 'dist'] as const)('%s entrypoint', (surface) => {
  const entrypointArgs = actionEntrypointArguments(path.resolve(__dirname, '..'), surface);
const root = path.resolve(__dirname, '..');

// contract_id: contract.ci-release-notes-input-resolution.outputs
// integration_id: ci-release-notes-input-resolution-contract-entrypoint
test('entrypoint resolves an external tag handoff', () => {
  // Arrange
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-notes-entrypoint-'));
  const source = path.join(tempRoot, 'source');
  const output = path.join(tempRoot, 'output');
  const outputFile = path.join(tempRoot, 'outputs');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'release-notes.json'), '{}');
  fs.writeFileSync(path.join(source, 'release-notes-approval.json'), '{}');
  fs.writeFileSync(outputFile, '', 'utf8');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: outputFile, 'INPUT_INPUT-HANDOFF-DIRECTORY': source, 'INPUT_OUTPUT-DIRECTORY': output } as Record<string, string>;
  // Act
  const result = spawnSync(process.execPath, [...entrypointArgs], { cwd: root, env, encoding: 'utf8' });
  // Assert
  expect(result.status).toBe(0);
  const outputs = fs.readFileSync(outputFile, 'utf8');
  expect(outputs.match(/^release-notes-path<<([^\n]+)\n([^\n]+)\n\1$/m)?.[2]).toBe(path.join(output, 'release-notes.json'));
  expect(fs.existsSync(path.join(output, 'release-notes.json'))).toBe(true);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

// contract_id: contract.ci-release-notes-input-resolution.outputs
// integration_id: ci-release-notes-input-resolution-contract-entrypoint
test('entrypoint rejects an existing normalized handoff', () => {
  for (const occupied of ['release-notes.json', 'release-notes-approval.json']) {
    for (const kind of ['file', 'dangling-link', 'directory']) {
      // Arrange
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-notes-entrypoint-rejected-'));
      const source = path.join(tempRoot, 'source');
      const output = path.join(tempRoot, 'output');
      const outputFile = path.join(tempRoot, 'outputs');
      fs.mkdirSync(source);
      fs.mkdirSync(output);
      fs.writeFileSync(path.join(source, 'release-notes.json'), '{}');
      fs.writeFileSync(path.join(source, 'release-notes-approval.json'), '{}');
      const destination = path.join(output, occupied);
      const unexpectedTarget = path.join(tempRoot, 'unexpected-target');
      if (kind === 'file') fs.writeFileSync(destination, 'existing');
      else if (kind === 'directory') fs.mkdirSync(destination);
      else fs.symlinkSync(unexpectedTarget, destination);
      fs.writeFileSync(outputFile, '', 'utf8');
      const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: outputFile, 'INPUT_INPUT-HANDOFF-DIRECTORY': source, 'INPUT_OUTPUT-DIRECTORY': output } as Record<string, string>;

      // Act
      const result = spawnSync(process.execPath, [...entrypointArgs], { cwd: root, env, encoding: 'utf8' });

      // Assert
      try {
        expect(result.status).not.toBe(0);
        const outputs = fs.readFileSync(outputFile, 'utf8');
        expect(outputs).toMatch(/failed/);
        expect(outputs).not.toMatch(/success|release-notes-path|approval-path/);
        expect(fs.existsSync(unexpectedTarget)).toBe(false);
        const other = occupied === 'release-notes.json' ? 'release-notes-approval.json' : 'release-notes.json';
        expect(fs.existsSync(path.join(output, other))).toBe(false);
        if (kind === 'file') expect(fs.readFileSync(destination, 'utf8')).toBe('existing');
        else if (kind === 'directory') expect(fs.lstatSync(destination).isDirectory()).toBe(true);
        else expect(fs.readlinkSync(destination)).toBe(unexpectedTarget);
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    }
  }
});

});
