import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';


const root = path.resolve(__dirname, '..');
const git = (cwd: string, ...args: string[]): string => execFileSync(
  'git',
  args,
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
).trim();
const runBundled = (base: 'head' | string) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-change-scope-'));
  git(tempRoot, 'init', '--quiet');
  git(tempRoot, 'config', 'user.email', 'ci-change-scope@example.invalid');
  git(tempRoot, 'config', 'user.name', 'CI Change Scope Test');
  fs.writeFileSync(path.join(tempRoot, 'README.md'), '# fixture\n', 'utf8');
  git(tempRoot, 'add', 'README.md');
  git(tempRoot, 'commit', '--quiet', '-m', 'fixture');
  const head = git(tempRoot, 'rev-parse', 'HEAD');
  const output = path.join(tempRoot, 'outputs');
  fs.writeFileSync(output, '', 'utf8');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output } as Record<string, string>;
  env['INPUT_BASE-SHA'] = base === 'head' ? head : base;
  env['INPUT_HEAD-SHA'] = head;
  env['INPUT_DOCS-ONLY-PATTERNS'] = 'docs/**,README.md,**/*.md';
  const result = spawnSync(process.execPath, [path.join(root, 'dist/index.js')], { cwd: tempRoot, env, encoding: 'utf8' });
  return { output, result, tempRoot };
};

// contract_id: contract.ci-change-scope.outputs
// integration_id: ci-change-scope-contract-entrypoint
test('bundled entrypoint reports a valid range', () => {
  // Arrange
  // Act
  const run = runBundled('head');
  // Assert
  try {
    assert.equal(run.result.status, 0);
    assert.match(fs.readFileSync(run.output, 'utf8'), /status<</);
    assert.match(fs.readFileSync(run.output, 'utf8'), /success/);
  } finally {
    fs.rmSync(run.tempRoot, { recursive: true, force: true });
  }
});

// integration_id: ci-change-scope-entrypoint-regression
test('bundled entrypoint fails open for an invalid SHA', () => {
  // Arrange
  // Act
  const run = runBundled('--relative=src');
  // Assert
  try {
    assert.equal(run.result.status, 0);
    const output = fs.readFileSync(run.output, 'utf8');
    assert.match(output, /unresolved/);
    assert.match(output, /run-ci/);
  } finally {
    fs.rmSync(run.tempRoot, { recursive: true, force: true });
  }
});
