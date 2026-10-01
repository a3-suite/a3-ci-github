import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { collectRuntimeGraph, inspectRuntimeGraph } from '../runtime/repository/check-runtime-boundaries.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compiler = createRequire(path.join(repository, 'actions/ci-release-assembly/package.json'))('typescript');
const fixture = (t, files) => {
  const parent = path.join(repository, 'tests/tmp');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'runtime-boundary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [relative, source] of Object.entries(files)) {
    const filename = path.join(root, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, source);
  }
  const graph = collectRuntimeGraph(root, [{ path: path.join(root, 'actions/example') }], compiler);
  return inspectRuntimeGraph(root, graph);
};

test('runtime boundary inspection permits Action to shared core dependencies and ignores comments and type-only edges', (t) => {
  const findings = fixture(t, {
    'actions/example/src/index.ts': "import '../../../runtime/core'; export type Token = string;",
    'runtime/core.ts': "import type { Token } from '../actions/example/src/index'; export { type Token } from '../actions/example/src/index'; // import '../actions/example/src/index';\nexport const text = \"import '../actions/example/src/index'\";",
  });
  assert.deepEqual(findings, []);
});
for (const [label, source] of [
  ['static import', "import '../actions/example/src/index';"],
  ['reexport', "export * from '../actions/example/src/index';"],
  ['dynamic literal import', "void import('../actions/example/src/index');"],
  ['dynamic template literal import', 'void import(`../actions/example/src/index`);'],
  ['require', "require('../actions/example/src/index');"],
  ['TypeScript import equals', "import entry = require('../actions/example/src/index');"],
]) {
  test(`runtime boundary inspection rejects reverse ${label}`, (t) => {
    const findings = fixture(t, { 'actions/example/src/index.ts': "import '../../../runtime/core';", 'runtime/core.ts': source });
    assert.ok(findings.some((finding) => finding.startsWith('runtime-to-action:')));
  });
}
test('both publication Actions include actual shared implementation in strict typechecking', () => {
  for (const name of ['ci-release-assembly', 'ci-release-publication-verifier']) {
    const configPath = path.join(repository, 'actions', name, 'tsconfig.json');
    const parsed = compiler.getParsedCommandLineOfConfigFile(configPath, {}, { ...compiler.sys, onUnRecoverableConfigFileDiagnostic: () => assert.fail('invalid tsconfig') });
    assert.equal(parsed.options.strict, true);
    const program = compiler.createProgram(parsed.fileNames, parsed.options);
    for (const file of ['io.ts', 'schema.ts', 'assembly.ts', 'observation.ts']) {
      const source = program.getSourceFile(path.join(repository, 'runtime/release-publication', file));
      assert.ok(source, `${name}: shared implementation missing: ${file}`);
      assert.equal(source.isDeclarationFile, false);
    }
  }
});

test('runtime boundary inspection rejects shared implementation cycles', (t) => {
  const findings = fixture(t, {
    'actions/example/src/index.ts': "import '../../../runtime/one';",
    'runtime/one.ts': "import './two';",
    'runtime/two.ts': "import './one';",
  });
  assert.ok(findings.some((finding) => finding.startsWith('runtime-cycle:')));
});
