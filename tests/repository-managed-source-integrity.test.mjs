import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const filesUnder = (directory, relative = '') => readdirSync(path.join(directory, relative), { withFileTypes: true }).flatMap((entry) => {
  const child = path.join(relative, entry.name);
  assert.equal(entry.isFile() || entry.isDirectory(), true, `unsupported workflow source entry: ${child}`);
  return entry.isDirectory() ? filesUnder(directory, child) : [child];
});

// integration_id: repository-managed-source-integrity
test('managed source inventory resolves every canonical repository asset', () => {
  for (const relative of ['actions', 'workflows', 'runtime', 'lint-rules/a3-lint', 'skills/ci-github', 'sdd', 'tests']) {
    assert.equal(existsSync(path.join(root, relative)), true, relative);
  }
  const registry = readFileSync(path.join(root, 'skills/ci-github/references/ci-github-preset-assets.reference.yml'), 'utf8');
  for (const match of registry.matchAll(/^\s+source:\s+((?:workflows|runtime|lint-rules)\/\S+)\s*$/gm)) {
    assert.equal(existsSync(path.join(root, match[1])), true, match[1]);
  }
});

// integration_id: repository-managed-source-integrity
test('canonical workflow source root contains only workflow YAML', () => {
  const files = filesUnder(path.join(root, 'workflows'));
  assert.ok(files.length > 0);
  assert.deepEqual(files.filter((file) => !file.endsWith('.yml')), []);
});

// integration_id: repository-managed-source-integrity
test('managed source inventory rejects stale legacy locations', () => {
  for (const relative of ['scripts/ci-github', 'scripts/rust-release', 'skills/ci/ci-github']) {
    assert.equal(existsSync(path.join(root, relative)), false, relative);
  }
});
