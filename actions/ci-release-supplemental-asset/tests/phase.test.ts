import fs from 'node:fs';
import path from 'node:path';
import { describe, test, expect } from 'vitest';
import { runSupplemental } from '../../../runtime/release-publication/supplemental';
import { hashFile } from '../../../runtime/release-publication/io';
import { fixture } from './fixtures';

describe('supplemental-phase-source', () => {
  // contract_id: contract.ci-release-supplemental-asset.outputs
  // integration_id: supplemental-phase-source
  for (const operation of ['build-platform', 'assemble']) {
    test(`supplemental source preserves the v2 ${operation} argument vector`, (t) => {
      const f = fixture(t);
      f.configure({ CI_SUPPLEMENTAL_RELEASE_ASSET_OWNER_CONTRACT: 'owner.installer-contract#selected-meaning' });
      f.options.operation = operation;
      if (operation === 'assemble') f.options.supplementalBuildRoot = 'supplemental build';
      runSupplemental(f.options);
      expect(fs.readFileSync(path.join(f.root, 'new output/arguments'), 'utf8')).toBe([operation, 'authority.json', 'snapshot.json', 'standard build', ...(operation === 'assemble' ? ['supplemental build'] : []), 'new output', ''].join('\n'));
    });
  }
});

describe('supplemental source rejects unsafe paths, invalid phases and existing outputs', () => {
  const cases = [
    { operation: 'unknown' }, { operation: 'assemble' },
    { supplementalBuildRoot: 'supplemental build' },
    { standardBuildRoot: '../escape' }, { outputDirectory: '../escape' },
    { outputDirectory: 'standard build/overlap' }, { outputDirectory: 'STANDARD BUILD/overlap' },
    { outputDirectory: '.git/overlap' },
    { outputDirectory: 'standard build' }, { outputDirectory: 'dangling' },
    { standardBuildRoot: 'symlink' },
    { operation: 'assemble', supplementalBuildRoot: 'standard build' },
    { operation: 'assemble', supplementalBuildRoot: 'STANDARD BUILD' },
  ];
  for (const changes of cases) test(JSON.stringify(changes), (sub) => {
    const f = fixture(sub);
    fs.symlinkSync(path.join(f.root, 'standard build'), path.join(f.root, 'symlink'));
    fs.symlinkSync(path.join(f.root, 'missing'), path.join(f.root, 'dangling'));
    if (changes.outputDirectory === 'STANDARD BUILD/overlap' && !fs.existsSync(path.join(f.root, 'STANDARD BUILD'))) {
      sub.skip('filesystem does not alias path casing');
      return;
    }
    expect(() => runSupplemental({ ...f.options, ...changes })).toThrow();
    expect(fs.existsSync(path.join(f.root, 'new output'))).toBe(false);
    if (changes.outputDirectory === 'STANDARD BUILD/overlap') expect(fs.existsSync(path.join(f.root, changes.outputDirectory))).toBe(false);
  });
});

describe('supplemental source rejects snapshot, source and owner selection mismatches', () => {
  for (const field of ['snapshot', 'source', 'contract', 'adapter', 'dirty-adapter', 'dirty-adapter-eol']) test(field, (sub) => {
    const f = fixture(sub);
    if (field === 'snapshot') fs.writeFileSync(path.join(f.root, 'snapshot.json'), '{}');
    if (field === 'source') f.configure({}, { source_sha: 'a'.repeat(40) });
    if (field === 'contract') f.configure({ CI_SUPPLEMENTAL_RELEASE_ASSET_OWNER_CONTRACT: '__unset__' });
    if (field === 'adapter') f.configure({ CI_SUPPLEMENTAL_RELEASE_ASSET_ADAPTER: '../escape' });
    if (field === 'dirty-adapter') fs.appendFileSync(path.join(f.root, '.ci/scripts/ci-release-supplemental-asset.sh'), '\n# not from the authority commit\n');
    if (field === 'dirty-adapter-eol') {
      const filename = path.join(f.root, '.ci/scripts/ci-release-supplemental-asset.sh');
      fs.writeFileSync(filename, fs.readFileSync(filename, 'utf8').replaceAll('\n', '\r\n'));
    }
    expect(() => runSupplemental(f.options)).toThrow();
    expect(fs.existsSync(path.join(f.root, 'new output'))).toBe(false);
  });
});

describe('supplemental source rejects mutated authority, snapshot, adapter and supplemental inputs', () => {
  const changes = [
    'printf changed > "$2"', 'printf changed > "$3"', 'printf "\\n# changed\\n" >> "$0"',
    'printf changed > "$5/input"', 'printf "%040d\\n" 0 > .git/HEAD',
    'mv "$4" moved-standard && ln -s moved-standard "$4"',
    ...(process.platform === 'win32' ? [] : ['chmod 700 "$4"']),
  ];
  for (const change of changes) test(change, (sub) => {
    const f = fixture(sub, 'mkdir -p -- "${!#}"\nprintf data > "${!#}/asset"\n' + change);
    f.options.operation = 'assemble';
    f.options.supplementalBuildRoot = 'supplemental build';
    expect(() => runSupplemental(f.options)).toThrow();
    expect(fs.existsSync(path.join(f.root, 'new output/asset'))).toBe(true);
  });
});

describe('supplemental source accepts empty markers and rejects their mutation', () => {
  for (const mutate of [false, true]) test(String(mutate), (sub) => {
    const f = fixture(sub, 'mkdir -p -- "$6"\nprintf data > "$6/asset"\n' + (mutate ? 'printf changed > "$5/marker"' : ''));
    f.options.operation = 'assemble';
    f.options.supplementalBuildRoot = 'supplemental build';
    fs.writeFileSync(path.join(f.root, 'standard build/marker'), '');
    fs.writeFileSync(path.join(f.root, 'supplemental build/marker'), '');
    expect(() => hashFile(path.join(f.root, 'standard build/marker'))).toThrow(/asset-size-or-kind-invalid/);
    if (mutate) expect(() => runSupplemental(f.options)).toThrow(/build-input-mutated/);
    else expect(() => runSupplemental(f.options)).not.toThrow();
    expect(fs.existsSync(path.join(f.root, 'new output/asset'))).toBe(true);
  });
});

describe('supplemental-phase-source', () => {
  test('supplemental source preserves owner shebang failure semantics', (t) => {
    const f = fixture(t, 'false\nmkdir -p -- "$5"\nprintf data > "$5/asset"', '#!/bin/bash -e\n');
    expect(() => runSupplemental(f.options)).toThrow(/owner-adapter-failed/);
    expect(fs.existsSync(path.join(f.root, 'new output'))).toBe(false);
  });
});

describe('supplemental source rejects missing and empty owner output', () => {
  for (const body of ['true', 'mkdir -p -- "${!#}"']) test(body, (sub) => {
    const f = fixture(sub, body);
    expect(() => runSupplemental(f.options)).toThrow();
  });
});
