import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test, describe, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');

describe("repository-cli-specification", () => {
  // evidence_role: supplemental
  // test_level: integration
  // integration_id: repository-cli-specification
  test('CLI specification indexes only repository-owned public entrypoints', () => {
    // Arrange
    const manifestPath = 'sdd/dsl/specs/cli/cli-command-manifest.sdd.yml';
    // Act
    const manifest = read(manifestPath);
    const externalCommandPresent = existsSync(path.join(root, 'sdd/dsl/specs/cli/commands/sdd-check'));
    // Assert
    for (const pattern of [
      /id: validate-ci-preset/,
      /id: generate-ci-asset-lock/,
      /id: materialize-adapter-bundle/,
      /id: manage-ci-distribution-fetch\n/,
      /id: manage-ci-distribution-verify\n/,
      /id: manage-ci-distribution-plan\n/,
      /id: manage-ci-distribution-apply\n/,
      /id: manage-ci-distribution-rollback\n/,
      /id: generate-ci-distribution-release/,
      /id: assemble-standard-installer/,
      /id: build-standard-installer-platform/,
    ]) {
      expect(manifest).toMatch(pattern);
    }
    expect(manifest).not.toMatch(/sdd-check/);
    expect(externalCommandPresent).toBe(false);
  });

  // evidence_role: supplemental
  // test_level: integration
  // integration_id: repository-cli-specification
  test('CLI specifications match public parser flags and usage bindings', () => {
    // Arrange
    const vocabularyPath = 'sdd/dsl/specs/cli/cli-option-vocabulary.sdd.yml';
    // Act
    const vocabulary = read(vocabularyPath);
    const cliRoot = 'sdd/dsl/specs/cli';
    const manifest = parse(read(`${cliRoot}/cli-command-manifest.sdd.yml`));
    const commands = manifest.commands.map(({ path: commandPath }) => parse(read(`${cliRoot}/${commandPath}`)).command);
    const fixedFlags = commands.flatMap(({ path: tokens }) => tokens.filter((token) => token.startsWith('--')));
    const options = new Map(parse(vocabulary).options.map(({ id, long }) => [id, long]));
    const implementations = [
      read('runtime/preset/run-validate-ci-preset.mjs'),
      read('runtime/preset/generate-ci-asset-lock.ts'),
      read('runtime/adapter/materialize-adapter-bundle.ts'),
      read('runtime/distribution/fetch-a3-ci-github.mjs'),
      read('runtime/distribution/generate-distribution-release.ts'),
      read('runtime/installer/cli.ts'),
    ].join('\n');
    const declared = [...new Set([...options.values(), ...fixedFlags])];
    // Assert
    expect(declared.sort()).toStrictEqual([
      '--set',
      '--approve', '--asset', '--audit-mode', '--bundle', '--inventory', '--manifest',
      '--manifest-url', '--output', '--output-directory', '--plan', '--preset', '--release-tag',
      '--repo-root', '--repository-root', '--skill-collection-root', '--source-revision',
      '--source-root', '--target-root', '--transaction',
      '--operation', '--authority-path', '--snapshot-path', '--standard-build-root', '--supplemental-build-root', '--provider-revision',
    ].sort());
    for (const flag of declared) expect(implementations.includes(`'${flag}'`) || read('runtime/installer/cli.ts').includes(`'${flag.slice(2)}'`), flag).toBe(true);
    for (const command of commands) {
      const prefix = `${command.path.join(' ')} `;
      const displayed = command.usage.map((usage) => {
        expect(usage.startsWith(prefix), command.id).toBe(true);
        return (usage.slice(prefix.length).match(/--[a-z][a-z0-9-]*/g) ?? []).sort().join(' ');
      });
      const bound = command.usage_targets.map((target) => target.option_bindings
        .map(({ option_id }) => options.get(option_id)).sort().join(' '));
      expect(new Set(displayed), command.id).toEqual(new Set(bound));
    }
    expect(vocabulary).toMatch(/resolving a relative path from the process working directory/);
  });

  // evidence_role: supplemental
  // test_level: integration
  // integration_id: repository-cli-specification
  test('validate preset usage keeps read-only output invalid', () => {
    // Arrange
    const specificationPath = 'sdd/dsl/specs/cli/commands/validate-ci-preset/cli-command.sdd.yml';
    // Act
    const specification = read(specificationPath);
    const [readOnly, remediation] = specification.split('    - id: remediation');
    // Assert
    expect(readOnly).not.toMatch(/option_id: output/);
    expect(remediation).toMatch(/option_id: output/);
    expect(specification).toMatch(/--audit-mode read-only[^\n]*\n    - node[^\n]*--audit-mode remediation[^\n]*--output/);
  });
});
