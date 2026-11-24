import fs from 'node:fs';
import path from 'node:path';
import { describe, test, expect, type TestContext } from 'vitest';
import { hashFile } from '../../../runtime/release-publication/io';
import { fixture, rejectAction, runAction } from './fixtures';

describe('supplemental-phase-source', () => {
  // contract_id: contract.ci-release-supplemental-asset.outputs
  // integration_id: supplemental-phase-source
  for (const operation of ['build-platform', 'assemble']) {
    test(`supplemental source preserves the v2 ${operation} argument vector`, (t) => {
      const f = fixture(t);
      f.configure({ CI_SUPPLEMENTAL_RELEASE_ASSET_OWNER_CONTRACT: 'owner.installer-contract#selected-meaning' });
      f.options.operation = operation;
      if (operation === 'assemble') f.options.supplementalBuildRoot = 'supplemental build';
      runAction(f, f.options);
      expect(fs.readFileSync(path.join(f.root, 'new output/arguments'), 'utf8')).toBe([operation, 'authority.json', 'snapshot.json', 'standard build', ...(operation === 'assemble' ? ['supplemental build'] : []), 'new output', ''].join('\n'));
    });
  }
});

const unsafePathCases = [
  { operation: 'unknown' }, { operation: 'assemble' },
  { supplementalBuildRoot: 'supplemental build' },
  { standardBuildRoot: '../escape' }, { outputDirectory: '../escape' },
  { outputDirectory: 'standard build/overlap' }, { outputDirectory: 'STANDARD BUILD/overlap' },
  { outputDirectory: '.git/overlap' },
  { standardBuildRoot: 'symlink' },
  { operation: 'assemble', supplementalBuildRoot: 'standard build' },
  { operation: 'assemble', supplementalBuildRoot: 'STANDARD BUILD' },
];
const existingOutputCases = [{ outputDirectory: 'standard build' }, { outputDirectory: 'dangling' }];
const unsafePathFixture = (sub: TestContext) => {
  const f = fixture(sub);
  fs.symlinkSync(path.join(f.root, 'standard build'), path.join(f.root, 'symlink'));
  fs.symlinkSync(path.join(f.root, 'missing'), path.join(f.root, 'dangling'));
  return f;
};
const aliasesPathCasing = (f: ReturnType<typeof fixture>, changes: { outputDirectory?: string }) =>
  changes.outputDirectory !== 'STANDARD BUILD/overlap' || fs.existsSync(path.join(f.root, 'STANDARD BUILD'));

describe('supplemental source rejects unsafe paths and invalid phases', () => {
  for (const changes of unsafePathCases) test(JSON.stringify(changes), (sub) => {
    const f = unsafePathFixture(sub);
    if (!aliasesPathCasing(f, changes)) {
      sub.skip('filesystem does not alias path casing');
      return;
    }
    rejectAction(f, { ...f.options, ...changes });
  });
});

// contract_id: contract.ci-release-supplemental-asset.outputs
// integration_id: supplemental-phase-source
describe('supplemental source rejects an existing output directory without changing it', () => {
  const directoryState = (directory: string) => fs.readdirSync(directory, { recursive: true, encoding: 'utf8' }).sort()
    .map((entry) => [entry, fs.statSync(path.join(directory, entry)).isFile() ? fs.readFileSync(path.join(directory, entry), 'utf8') : null]);
  test('standard build', (sub) => {
    // Arrange
    const f = unsafePathFixture(sub);
    const existing = path.join(f.root, 'standard build');
    const before = directoryState(existing);
    // Act
    rejectAction(f, { ...f.options, outputDirectory: 'standard build' });
    // Assert
    expect(directoryState(existing)).toStrictEqual(before);
  });
  test('dangling', (sub) => {
    // Arrange
    const f = unsafePathFixture(sub);
    const link = path.join(f.root, 'dangling');
    const before = { symbolicLink: fs.lstatSync(link).isSymbolicLink(), target: fs.readlinkSync(link) };
    // Act
    rejectAction(f, { ...f.options, outputDirectory: 'dangling' });
    // Assert
    expect({ symbolicLink: fs.lstatSync(link).isSymbolicLink(), target: fs.readlinkSync(link) }).toStrictEqual(before);
    expect(fs.existsSync(path.join(f.root, 'missing'))).toBe(false);
  });
});

// evidence_role: supplemental
// Creating no new output is a side effect of the rejection and follows from rust-release-build, not from the supplemental asset contract.
describe('supplemental source creates no new output when it rejects unsafe paths and invalid phases', () => {
  for (const changes of [...unsafePathCases, ...existingOutputCases]) test(JSON.stringify(changes), (sub) => {
    const f = unsafePathFixture(sub);
    if (!aliasesPathCasing(f, changes)) {
      sub.skip('filesystem does not alias path casing');
      return;
    }
    rejectAction(f, { ...f.options, ...changes });
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
    rejectAction(f, f.options);
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
    rejectAction(f, f.options);
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
    if (mutate) rejectAction(f, f.options, /build-input-mutated/);
    else expect(() => runAction(f, f.options)).not.toThrow();
  });
});

describe('supplemental-phase-source', () => {
  test('supplemental source preserves owner shebang failure semantics', (t) => {
    const f = fixture(t, 'false\nmkdir -p -- "$5"\nprintf data > "$5/asset"', '#!/bin/bash -e\n');
    rejectAction(f, f.options, /owner-adapter-failed/);
  });
});

// evidence_role: supplemental
// Creating no new output after a rejection is a side effect that follows from rust-release-build, not from the supplemental asset contract.
describe('supplemental source creates no new output when it rejects selection mismatches and owner failure', () => {
  for (const field of ['snapshot', 'source', 'contract', 'adapter', 'dirty-adapter', 'dirty-adapter-eol', 'owner-failure']) test(field, (sub) => {
    const f = field === 'owner-failure' ? fixture(sub, 'false\nmkdir -p -- "$5"\nprintf data > "$5/asset"', '#!/bin/bash -e\n') : fixture(sub);
    if (field === 'snapshot') fs.writeFileSync(path.join(f.root, 'snapshot.json'), '{}');
    if (field === 'source') f.configure({}, { source_sha: 'a'.repeat(40) });
    if (field === 'contract') f.configure({ CI_SUPPLEMENTAL_RELEASE_ASSET_OWNER_CONTRACT: '__unset__' });
    if (field === 'adapter') f.configure({ CI_SUPPLEMENTAL_RELEASE_ASSET_ADAPTER: '../escape' });
    if (field === 'dirty-adapter') fs.appendFileSync(path.join(f.root, '.ci/scripts/ci-release-supplemental-asset.sh'), '\n# not from the authority commit\n');
    if (field === 'dirty-adapter-eol') {
      const filename = path.join(f.root, '.ci/scripts/ci-release-supplemental-asset.sh');
      fs.writeFileSync(filename, fs.readFileSync(filename, 'utf8').replaceAll('\n', '\r\n'));
    }
    rejectAction(f, f.options);
    expect(fs.existsSync(path.join(f.root, 'new output'))).toBe(false);
  });
});

// evidence_role: supplemental
// An owner adapter that changed an input leaves its partial output; the rejection does not clean it up, and no contract guarantee covers that retention.
describe('supplemental source retains the partial output of a rejected input mutation', () => {
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
    rejectAction(f, f.options);
    expect(fs.existsSync(path.join(f.root, 'new output/asset'))).toBe(true);
  });
  for (const mutate of [false, true]) test(`empty markers ${String(mutate)}`, (sub) => {
    const f = fixture(sub, 'mkdir -p -- "$6"\nprintf data > "$6/asset"\n' + (mutate ? 'printf changed > "$5/marker"' : ''));
    f.options.operation = 'assemble';
    f.options.supplementalBuildRoot = 'supplemental build';
    fs.writeFileSync(path.join(f.root, 'standard build/marker'), '');
    fs.writeFileSync(path.join(f.root, 'supplemental build/marker'), '');
    if (mutate) rejectAction(f, f.options);
    else expect(() => runAction(f, f.options)).not.toThrow();
    expect(fs.existsSync(path.join(f.root, 'new output/asset'))).toBe(true);
  });
});

describe('supplemental source rejects missing and empty owner output', () => {
  for (const body of ['true', 'mkdir -p -- "${!#}"']) test(body, (sub) => {
    const f = fixture(sub, body);
    rejectAction(f, f.options);
  });
});

describe('supplemental-asset-release-source', () => {
  // contract_id: contract.ci-release-supplemental-asset.assembly
  // integration_id: supplemental-asset-release-source
  test('asset release runs the owner adapter with empty build roots and rejects build inputs or platform phases', (t) => {
    // Arrange
    const assetRelease = (sub: Parameters<typeof fixture>[0], values: Record<string, string> = {}) => {
      const f = fixture(sub);
      f.configure({ CI_RELEASE_IMPLEMENTATION: 'asset-release', CI_PLATFORM_MANIFEST: '__unset__', ...values },
        { language_profile: null, toolchain_version: null, platform_manifest: null, platform_manifest_sha256: null } as unknown as Record<string, string>);
      f.options.operation = 'assemble';
      f.options.supplementalBuildRoot = 'supplemental build';
      for (const directory of ['standard build', 'supplemental build']) fs.rmSync(path.join(f.root, directory, 'input'));
      return f;
    };
    const valid = assetRelease(t);
    const withBuild = assetRelease(t);
    fs.writeFileSync(path.join(withBuild.root, 'standard build/input'), 'product build');
    const platformPhase = assetRelease(t);
    platformPhase.options.operation = 'build-platform';
    delete platformPhase.options.supplementalBuildRoot;
    const installer = assetRelease(t, { CI_SUPPLEMENTAL_RELEASE_ASSET_IMPLEMENTATION: 'standard-installer',
      CI_SUPPLEMENTAL_RELEASE_ASSET_OWNER_CONTRACT: 'installer.asset-assembly-evidence-contract', CI_SUPPLEMENTAL_RELEASE_ASSET_CONFIG_PATH: '.ci/installer/assembly.json' });
    const platformEmpty = ['standard build', 'supplemental build'].map((directory) => {
      const f = fixture(t);
      f.options.operation = 'assemble';
      f.options.supplementalBuildRoot = 'supplemental build';
      fs.rmSync(path.join(f.root, directory, 'input'));
      return f;
    });
    const mixed = assetRelease(t);
    mixed.configure({ CI_RELEASE_IMPLEMENTATION: 'asset-release', CI_PLATFORM_MANIFEST: '.ci/platform-manifest.yml' },
      { language_profile: null, toolchain_version: null, platform_manifest: null, platform_manifest_sha256: null } as unknown as Record<string, string>);
    // Act
    runAction(valid, valid.options);
    // Assert
    expect(fs.readFileSync(path.join(valid.root, 'new output/arguments'), 'utf8')).toBe(['assemble', 'authority.json', 'snapshot.json', 'standard build', 'supplemental build', 'new output', ''].join('\n'));
    rejectAction(withBuild, withBuild.options, /unexpected-build-input/);
    rejectAction(platformPhase, platformPhase.options, /asset-release-phase-invalid/);
    rejectAction(installer, installer.options, /asset-release-phase-invalid/);
    for (const f of platformEmpty) rejectAction(f, f.options, /build-input-missing/);
    rejectAction(mixed, mixed.options, /platform-mismatch/);
    for (const f of [withBuild, platformPhase, installer, ...platformEmpty, mixed]) expect(fs.existsSync(path.join(f.root, 'new output'))).toBe(false);
  });
});
