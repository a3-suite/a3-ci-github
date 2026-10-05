import fs from 'node:fs';
import path from 'node:path';
import { test, describe, expect } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { collectRuntimeGraph, inspectRuntimeGraph } from '../runtime/repository/check-runtime-boundaries.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compiler = createRequire(path.join(repository, 'actions/ci-release-assembly/package.json'))('typescript');
const fixture = (t, files) => {
  const parent = path.join(repository, 'tests/tmp');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'runtime-boundary-'));
  t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [relative, source] of Object.entries(files)) {
    const filename = path.join(root, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, source);
  }
  return root;
};
const inspectFixture = (root) => inspectRuntimeGraph(
  root,
  collectRuntimeGraph(root, [{ path: path.join(root, 'actions/example') }], compiler),
);

describe("repository-runtime-boundary-verification", () => {
  // evidence_role: supplemental
  // test_level: integration
  // integration_id: repository-runtime-boundary-verification
  test('runtime boundary inspection permits Action to shared core dependencies and ignores comments and type-only edges', (t) => {
    // Arrange
    const fixtureRoot = fixture(t, {
      'actions/example/src/index.ts': "import '../../../runtime/core'; export type Token = string;",
      'runtime/core.ts': "import type { Token } from '../actions/example/src/index'; export { type Token } from '../actions/example/src/index'; // import '../actions/example/src/index';\nexport const text = \"import '../actions/example/src/index'\";",
    });
    // Act
    const findings = inspectFixture(fixtureRoot);
    // Assert
    expect(findings).toStrictEqual([]);
  });
});

describe("runtime-boundaries", () => {
  for (const [label, source] of [
    ['static import', "import '../actions/example/src/index';"],
    ['reexport', "export * from '../actions/example/src/index';"],
    ['dynamic literal import', "void import('../actions/example/src/index');"],
    ['dynamic template literal import', 'void import(`../actions/example/src/index`);'],
    ['require', "require('../actions/example/src/index');"],
    ['TypeScript import equals', "import entry = require('../actions/example/src/index');"],
  ]) {
    // evidence_role: supplemental
    // test_level: integration
    // integration_id: repository-runtime-boundary-verification
    test(`runtime boundary inspection rejects reverse ${label}`, (t) => {
      // Arrange
      const fixtureRoot = fixture(t, { 'actions/example/src/index.ts': "import '../../../runtime/core';", 'runtime/core.ts': source });
      // Act
      const findings = inspectFixture(fixtureRoot);
      // Assert
      expect(findings.some((finding) => finding.startsWith('runtime-to-action:'))).toBeTruthy();
    });
  }
});

describe("repository-runtime-boundary-verification", () => {
  // evidence_role: supplemental
  // test_level: integration
  // integration_id: repository-runtime-boundary-verification
  test('both publication Actions include actual shared implementation in strict typechecking', () => {
    for (const name of ['ci-release-assembly', 'ci-release-publication-verifier']) {
      // Arrange
      const configPath = path.join(repository, 'actions', name, 'tsconfig.json');
      // Act
      const parsed = compiler.getParsedCommandLineOfConfigFile(configPath, {}, { ...compiler.sys, onUnRecoverableConfigFileDiagnostic: () => expect.unreachable('invalid tsconfig') });
      const program = compiler.createProgram(parsed.fileNames, parsed.options);
      // Assert
      expect(parsed.options.strict).toBe(true);
      for (const file of ['io.ts', 'schema.ts', 'assembly.ts', 'observation.ts']) {
        const source = program.getSourceFile(path.join(repository, 'runtime/release-publication', file));
        expect(source, `${name}: shared implementation missing: ${file}`).toBeTruthy();
        expect(source.isDeclarationFile).toBe(false);
      }
    }
  });

  // evidence_role: supplemental
  // test_level: integration
  // integration_id: repository-runtime-boundary-verification
  test('Release Actions typecheck the shared control and notes binding implementations', () => {
    const targets = {
      'ci-release-publication-control': ['control.ts'],
      'ci-release-notes-binding': ['notes-binding.ts'],
      'ci-release-authority': ['control.ts', 'notes-binding.ts'],
      'ci-release-publisher': ['control.ts', 'notes-binding.ts'],
    };
    for (const [name, files] of Object.entries(targets)) {
      // Arrange
      const configPath = path.join(repository, 'actions', name, 'tsconfig.json');
      // Act
      const parsed = compiler.getParsedCommandLineOfConfigFile(configPath, {}, { ...compiler.sys, onUnRecoverableConfigFileDiagnostic: () => expect.unreachable('invalid tsconfig') });
      const program = compiler.createProgram(parsed.fileNames, parsed.options);
      // Assert
      expect(parsed.options.strict).toBe(true);
      for (const file of files) {
        const source = program.getSourceFile(path.join(repository, 'runtime/release-publication', file));
        expect(source, `${name}: shared implementation missing: ${file}`).toBeTruthy();
        expect(source.isDeclarationFile).toBe(false);
      }
    }
  });

  // evidence_role: supplemental
  // test_level: integration
  // integration_id: repository-runtime-boundary-verification
  test('runtime boundary inspection rejects shared implementation cycles', (t) => {
    // Arrange
    const fixtureRoot = fixture(t, {
      'actions/example/src/index.ts': "import '../../../runtime/one';",
      'runtime/one.ts': "import './two';",
      'runtime/two.ts': "import './one';",
    });
    // Act
    const findings = inspectFixture(fixtureRoot);
    // Assert
    expect(findings.some((finding) => finding.startsWith('runtime-cycle:'))).toBeTruthy();
  });

  // evidence_role: supplemental
  // test_level: integration
  // integration_id: repository-runtime-boundary-verification
  test('Action boundary inspection permits own implementation, shared runtime and type-only peer references', (t) => {
    // Arrange
    const fixtureRoot = fixture(t, {
      'actions/example/src/index.ts': "import './control'; import '../../../runtime/core'; import type { Token } from '../../example-extra/src/control'; // import '../../example-extra/src/control';",
      'actions/example/src/control.ts': 'export const value = 1;',
      'actions/example-extra/src/control.ts': 'export type Token = string;',
      'runtime/core.ts': 'export const shared = 1;',
    });
    // Act
    const findings = inspectFixture(fixtureRoot);
    // Assert
    expect(findings).toStrictEqual([]);
  });
});

describe("runtime-boundaries", () => {
  for (const source of [
    "import '../../example-extra/src/control';",
    "export * from '../../example-extra/src/control';",
  ]) {
    // evidence_role: supplemental
    // test_level: integration
    // integration_id: repository-runtime-boundary-verification
    test(`Action boundary inspection rejects peer implementation: ${source}`, (t) => {
      // Arrange
      const fixtureRoot = fixture(t, {
        'actions/example/src/index.ts': source,
        'actions/example-extra/src/control.ts': 'export const value = 1;',
      });
      // Act
      const findings = inspectFixture(fixtureRoot);
      // Assert
      expect(findings).toStrictEqual(['action-to-action: actions/example/src/index.ts -> actions/example-extra/src/control.ts']);
    });
  }
});
