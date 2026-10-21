import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, test, expect } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const yaml = createRequire(path.join(root, 'runtime/preset/package.json'))('yaml');
const action = yaml.parse(fs.readFileSync(path.join(root, 'actions/ci-quality-toolchain/action.yml'), 'utf8'));
const script = fs.readFileSync(path.join(root, 'actions/ci-quality-toolchain/scripts/setup-cargo-deny.sh'), 'utf8');
const realTar = spawnSync('bash', ['-c', 'command -v tar'], { encoding: 'utf8' }).stdout.trim();
const fixture = (target = 'x86_64-unknown-linux-musl') => {
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'tmp/cargo-deny-test-'));
  const bin = path.join(directory, 'bin');
  fs.mkdirSync(bin);
  const binary = target.endsWith('windows-msvc') ? 'cargo-deny.exe' : 'cargo-deny';
  const stem = `cargo-deny-0.20.2-${target}`;
  const name = `${stem}.tar.gz`;
  fs.mkdirSync(path.join(directory, stem));
  fs.writeFileSync(path.join(directory, stem, binary), '#!/bin/sh\necho "cargo-deny ${BINARY_VERSION:-0.20.2}"\n', { mode: 0o700 });
  const archive = path.join(directory, name);
  expect(spawnSync(realTar, ['-czf', archive, '-C', directory, stem]).status).toBe(0);
  fs.writeFileSync(path.join(directory, 'setup-cargo-deny.sh'), script);
  fs.writeFileSync(path.join(directory, 'cargo-deny-sha256sums.txt'), `${createHash('sha256').update(fs.readFileSync(archive)).digest('hex')}  ${name}\n`);
  const mock = (file, content) => fs.writeFileSync(path.join(bin, file), `#!/bin/bash\n${content}\n`, { mode: 0o700 });
  mock('uname', 'if [[ "$1" == -s ]]; then echo "$FIXTURE_OS"; else echo "$FIXTURE_ARCH"; fi');
  mock('cygpath', 'echo "$2"');
  mock('curl', 'echo curl >> "$CALLS"\n[[ "${FAILURE:-}" != download ]] || exit 22\nwhile (( $# )); do if [[ "$1" == --output ]]; then shift; output=$1; fi; shift; done\ncp "$FIXTURE_ARCHIVE" "$output"');
  mock('tar', `echo tar >> "$CALLS"\n[[ "${'${FAILURE:-}'}" != extract ]] || exit 9\nexec "${realTar}" "$@"`);
  mock('cargo', 'echo "cargo $*" >> "$CALLS"\nexit "${CARGO_EXIT:-0}"');
  return {
    directory, archive, name,
    env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH,
      CI_CARGO_DENY_VERSION: '0.20.2', RUNNER_TEMP: directory, GITHUB_PATH: path.join(directory, 'github-path'),
      CALLS: path.join(directory, 'calls'), FIXTURE_ARCHIVE: archive, FIXTURE_OS: 'Linux', FIXTURE_ARCH: 'x86_64' },
  };
};
const run = (f, env = {}) => spawnSync('bash', [path.join(f.directory, 'setup-cargo-deny.sh')], { encoding: 'utf8', env: { ...f.env, ...env } });
const calls = f => fs.existsSync(f.env.CALLS) ? fs.readFileSync(f.env.CALLS, 'utf8') : '';

describe('contract.ci-quality-toolchain.preparation', () => {
  // contract_id: contract.ci-quality-toolchain.preparation
  // flow_id: quality-toolchain-cargo-deny-prebuilt
  test('verified cargo-deny archive is extracted executed and exported without cargo compilation', () => {
    for (const [system, machine, target] of [
      ['Linux', 'x86_64', 'x86_64-unknown-linux-musl'],
      ['Linux', 'aarch64', 'aarch64-unknown-linux-musl'],
      ['Darwin', 'arm64', 'aarch64-apple-darwin'],
      ['Darwin', 'x86_64', 'x86_64-apple-darwin'],
      ['MINGW64_NT-10.0', 'x86_64', 'x86_64-pc-windows-msvc'],
    ]) {
      // Arrange
      const f = fixture(target);
      try {
        // Act
        const result = run(f, { FIXTURE_OS: system, FIXTURE_ARCH: machine });
        // Assert
        expect(result.status, result.stderr).toBe(0);
        expect(calls(f)).toBe('curl\ntar\n');
        const installed = fs.readFileSync(f.env.GITHUB_PATH, 'utf8').trim();
        expect(fs.readdirSync(installed)).toEqual([target.endsWith('windows-msvc') ? 'cargo-deny.exe' : 'cargo-deny']);
        expect(result.stdout).toContain(`installed verified ${target} binary`);
      } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
    }
  });

  // contract_id: contract.ci-quality-toolchain.preparation
  test('unregistered cargo-deny versions and targets retain source install and its exit status', () => {
    // Arrange
    const f = fixture();
    try {
      for (const env of [{ CI_CARGO_DENY_VERSION: '0.19.9' }, { FIXTURE_OS: 'MINGW64_NT-10.0', FIXTURE_ARCH: 'aarch64' }, { FIXTURE_OS: 'FreeBSD' }]) {
        fs.writeFileSync(f.env.CALLS, '');
        // Act
        const result = run(f, { ...env, CARGO_EXIT: '17' });
        // Assert
        expect(result.status).toBe(17);
        expect(calls(f)).toBe(`cargo install cargo-deny --locked --version ${env.CI_CARGO_DENY_VERSION ?? '0.20.2'}\n`);
        expect(fs.existsSync(f.env.GITHUB_PATH)).toBe(false);
      }
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
  });

  // contract_id: contract.ci-quality-toolchain.preparation
  test('registered cargo-deny asset failures stop without source fallback or PATH output', () => {
    for (const failure of ['checksum', 'download', 'extract', 'version', 'path', 'digest']) {
      // Arrange
      const f = fixture();
      try {
        if (failure === 'checksum') fs.appendFileSync(f.archive, 'modified');
        if (failure === 'digest') fs.writeFileSync(path.join(f.directory, 'cargo-deny-sha256sums.txt'), `invalid  ${f.name}\n`);
        // Act
        const result = run(f, { FAILURE: failure, ...(failure === 'version' ? { BINARY_VERSION: '0.20.1' } : {}),
          ...(failure === 'path' ? { GITHUB_PATH: path.join(f.directory, 'missing/path') } : {}) });
        // Assert
        expect(result.status).not.toBe(0);
        expect(calls(f)).not.toContain('cargo ');
        if (failure === 'checksum' || failure === 'download') expect(calls(f)).not.toContain('tar');
        if (failure === 'digest') expect(calls(f)).toBe('');
        expect(fs.existsSync(f.env.GITHUB_PATH)).toBe(false);
        expect(fs.readdirSync(f.directory).filter(name => name.startsWith('cargo-deny-bin-'))).toEqual([]);
      } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
    }
  });

  // contract_id: contract.ci-quality-toolchain.preparation
  test('invalid cargo-deny version stops before download or source install', () => {
    // Arrange
    const f = fixture();
    const validation = action.runs.steps.find((step) => step.id === 'validate-inputs').run;
    const selected = (profile, deny) => ({ ...process.env, CI_LANGUAGE_PROFILE: profile, CI_TOOLCHAIN_VERSION: '1.90.0', CI_UV_VERSION: '0.8.0', CI_CARGO_AUDIT_VERSION: '0.22.2', CI_CARGO_DENY_VERSION: deny });
    try {
      for (const version of ['', 'latest', '0.20.2\n', '../0.20.2']) {
        // Act
        const result = run(f, { CI_CARGO_DENY_VERSION: version });
        // Assert
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('quality-toolchain-cargo-deny-version-invalid');
        expect(calls(f)).toBe('');
      }
      for (const [profile, deny] of [['rust', 'latest'], ['rust', '0.20'], ['python', '0.20.2'], ['typescript', '0.20.2']]) {
        // Act
        const result = spawnSync('bash', ['-c', validation], { encoding: 'utf8', env: selected(profile, deny) });
        // Assert
        expect(result.status, `${profile} ${deny}`).toBe(1);
        expect(result.stderr).toContain('quality-toolchain-cargo-deny-version-invalid');
      }
      for (const [profile, deny] of [['rust', '0.20.2'], ['rust', ''], ['python', '']]) {
        expect(spawnSync('bash', ['-c', validation], { encoding: 'utf8', env: selected(profile, deny) }).status, `${profile} ${deny}`).toBe(0);
      }
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
  });
});
