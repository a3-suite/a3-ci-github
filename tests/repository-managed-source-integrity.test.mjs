import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { test, describe, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { parseDocument, isScalar, visit } from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const filesUnder = (directory, relative = '') => readdirSync(path.join(directory, relative), { withFileTypes: true }).flatMap((entry) => {
  const child = path.join(relative, entry.name);
  expect(entry.isFile() || entry.isDirectory(), `unsupported workflow source entry: ${child}`).toBe(true);
  return entry.isDirectory() ? filesUnder(directory, child) : [child];
});

describe("repository-managed-source-integrity", () => {
  // integration_id: repository-managed-source-integrity
  test('managed source inventory resolves every canonical repository asset', () => {
    for (const relative of ['actions', 'workflows', 'runtime', 'lint-rules/a3-lint', 'lint-rules/repository', 'skills/ci-github', 'sdd', 'tests']) {
      expect(statSync(path.join(root, relative)).isDirectory(), relative).toBe(true);
    }
    const registry = readFileSync(path.join(root, 'skills/ci-github/assets/registry/ci-github-preset-assets.yml'), 'utf8');
    const document = parseDocument(registry);
    expect(document.errors).toStrictEqual([]);
    const registered = [];
    visit(document, {
      Pair(_key, pair) {
        if (!isScalar(pair.key) || !isScalar(pair.value)) return;
        const source = pair.value.value;
        if (['source', 'preflightEntrypoint', 'integrityLockEntrypoint'].includes(pair.key.value)
          && typeof source === 'string' && /^(workflows|runtime|lint-rules)\//.test(source)) registered.push(source);
      },
    });
    expect(registered.length).toBeGreaterThan(0);
    for (const source of registered) {
      expect(existsSync(path.join(root, source)), source).toBe(true);
    }
  });

  // integration_id: repository-managed-source-integrity
  test('canonical workflow source root contains only workflow YAML', () => {
    const files = filesUnder(path.join(root, 'workflows'));
    expect(files.length > 0).toBeTruthy();
    expect(files.filter((file) => !file.endsWith('.yml'))).toStrictEqual([]);
  });
});
