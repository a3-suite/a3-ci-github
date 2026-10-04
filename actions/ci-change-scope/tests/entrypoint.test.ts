import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';


import { actionEntrypointArguments } from '../../../tests/support/action-entrypoint';

describe.each(['source', 'dist'] as const)('%s entrypoint', (surface) => {
  const entrypointArgs = actionEntrypointArguments(path.resolve(__dirname, '..'), surface);
const root = path.resolve(__dirname, '..');
const git = (cwd: string, ...args: string[]): string => execFileSync(
  'git',
  args,
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
).trim();
const runBundled = (base: 'head' | string, files: string[] = []) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-change-scope-'));
  git(tempRoot, 'init', '--quiet');
  git(tempRoot, 'config', 'user.email', 'ci-change-scope@example.invalid');
  git(tempRoot, 'config', 'user.name', 'CI Change Scope Test');
  git(tempRoot, 'config', 'core.quotePath', 'true');
  fs.writeFileSync(path.join(tempRoot, 'README.md'), '# fixture\n', 'utf8');
  git(tempRoot, 'add', 'README.md');
  git(tempRoot, 'commit', '--quiet', '-m', 'fixture');
  const comparison = git(tempRoot, 'rev-parse', 'HEAD');
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(tempRoot, file)), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, file), 'changed\n', 'utf8');
  }
  if (files.length > 0) {
    git(tempRoot, 'add', '.');
    git(tempRoot, 'commit', '--quiet', '-m', 'changes');
  }
  const head = git(tempRoot, 'rev-parse', 'HEAD');
  const output = path.join(tempRoot, 'outputs');
  fs.writeFileSync(output, '', 'utf8');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output } as Record<string, string>;
  env['INPUT_BASE-SHA'] = base === 'head' ? comparison : base;
  env['INPUT_HEAD-SHA'] = head;
  env['INPUT_DOCS-ONLY-PATTERNS'] = 'docs/**,README.md,**/*.md';
  const result = spawnSync(process.execPath, [...entrypointArgs], { cwd: tempRoot, env, encoding: 'utf8' });
  return { output, result, tempRoot };
};

// contract_id: contract.ci-change-scope.outputs
// integration_id: ci-change-scope-contract-entrypoint
test('entrypoint reports a valid range', () => {
  for (const files of [[], ['docs/日本語.md', 'docs/line\nbreak.md', 'docs/ space .md', 'docs/back\\slash.md'], [' README.md ', 'source.ts']]) {
    // Arrange
    const sorted = [...files].sort();
    // Act
    const run = runBundled('head', files);
    // Assert
    try {
      expect(run.result.status).toBe(0);
      const output = fs.readFileSync(run.output, 'utf8');
      const value = (name: string): string | undefined => output.match(new RegExp(`^${name}<<([^\\n]+)\\n([\\s\\S]*?)\\n\\1$`, 'm'))?.[2];
      expect(value('status')).toBe('success');
      expect(value('run-ci')).toBe(String(files.includes('source.ts')));
      expect(value('run-docs')).toBe(String(files.some((file) => file.startsWith('docs/'))));
      expect(value('files')).toBe(sorted.join('\n'));
      expect(value('docs-files')).toBe(sorted.filter((file) => file.startsWith('docs/')).join('\n'));
      expect(value('other-files')).toBe(sorted.filter((file) => !file.startsWith('docs/')).join('\n'));
    } finally {
      fs.rmSync(run.tempRoot, { recursive: true, force: true });
    }
  }
});

// integration_id: ci-change-scope-entrypoint-regression
test('entrypoint fails open for an invalid SHA', () => {
  // Arrange
  // Act
  const run = runBundled('--relative=src');
  // Assert
  try {
    expect(run.result.status).toBe(0);
    const output = fs.readFileSync(run.output, 'utf8');
    expect(output).toMatch(/unresolved/);
    expect(output).toMatch(/run-ci/);
  } finally {
    fs.rmSync(run.tempRoot, { recursive: true, force: true });
  }
});

});
