import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test, describe, expect } from 'vitest';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const filesUnder = (directory, relative = '') => readdirSync(path.join(directory, relative), { withFileTypes: true }).flatMap((entry) => {
  const child = path.join(relative, entry.name);
  expect(entry.isFile() || entry.isDirectory(), `unsupported workflow source entry: ${child}`).toBe(true);
  return entry.isDirectory() ? filesUnder(directory, child) : [child];
});

describe("repository-managed-source-integrity", () => {
  // integration_id: repository-managed-source-integrity
  test('managed source inventory resolves every canonical repository asset', () => {
    for (const relative of ['actions', 'workflows', 'runtime', 'lint-rules/a3-lint', 'skills/ci-github', 'sdd', 'tests']) {
      expect(existsSync(path.join(root, relative)), relative).toBe(true);
    }
    const registry = readFileSync(path.join(root, 'skills/ci-github/references/ci-github-preset-assets.reference.yml'), 'utf8');
    for (const match of registry.matchAll(/^\s+source:\s+((?:workflows|runtime|lint-rules)\/\S+)\s*$/gm)) {
      expect(existsSync(path.join(root, match[1])), match[1]).toBe(true);
    }
  });

  // integration_id: repository-managed-source-integrity
  test('canonical workflow source root contains only workflow YAML', () => {
    const files = filesUnder(path.join(root, 'workflows'));
    expect(files.length > 0).toBeTruthy();
    expect(files.filter((file) => !file.endsWith('.yml'))).toStrictEqual([]);
  });

  // integration_id: repository-managed-source-integrity
  test('managed source inventory rejects stale legacy locations', () => {
    for (const relative of ['scripts/ci-github', 'scripts/rust-release', 'skills/ci/ci-github']) {
      expect(existsSync(path.join(root, relative)), relative).toBe(false);
    }
  });
});
