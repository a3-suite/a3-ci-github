import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, test, expect } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const script = fs.readFileSync(path.join(root, 'actions/ci-quality-toolchain/scripts/setup-cargo-audit.sh'), 'utf8');
const realTar = spawnSync('bash', ['-c', 'command -v tar'], { encoding: 'utf8' }).stdout.trim();
const fixture = (target = 'x86_64-unknown-linux-gnu') => {
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'tmp/cargo-audit-test-'));
  const bin = path.join(directory, 'bin');
  fs.mkdirSync(bin);
  const windows = target.endsWith('windows-msvc');
  const binary = windows ? 'cargo-audit.exe' : 'cargo-audit';
  const stem = `cargo-audit-${target}-v0.22.2`;
  const name = `${stem}.${windows ? 'zip' : 'tgz'}`;
  fs.mkdirSync(path.join(directory, stem));
  fs.writeFileSync(path.join(directory, stem, binary), '#!/bin/sh\necho "cargo-audit ${BINARY_VERSION:-0.22.2}"\n', { mode: 0o700 });
  const archive = path.join(directory, name);
  const packed = windows
    ? spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],"w"); z.write(sys.argv[2],sys.argv[3]); z.close()', archive, path.join(directory, stem, binary), `${stem}/${binary}`])
    : spawnSync(realTar, ['-czf', archive, '-C', directory, stem]);
  expect(packed.status).toBe(0);
  fs.writeFileSync(path.join(directory, 'setup-cargo-audit.sh'), script);
  fs.writeFileSync(path.join(directory, 'cargo-audit-sha256sums.txt'), `${createHash('sha256').update(fs.readFileSync(archive)).digest('hex')}  ${name}\n`);
  const mock = (name, content) => fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${content}\n`, { mode: 0o700 });
  mock('uname', 'if [[ "$1" == -s ]]; then echo "$FIXTURE_OS"; else echo "$FIXTURE_ARCH"; fi');
  mock('getconf', '[[ "$FIXTURE_LIBC" == gnu ]]');
  mock('ldd', 'echo "$FIXTURE_LIBC"');
  mock('cygpath', 'echo "$2"');
  mock('curl', 'echo curl >> "$CALLS"\n[[ "${FAILURE:-}" != download ]] || exit 22\nwhile (( $# )); do if [[ "$1" == --output ]]; then shift; output=$1; fi; shift; done\ncp "$FIXTURE_ARCHIVE" "$output"');
  mock('tar', `echo tar >> "$CALLS"\n[[ "${'${FAILURE:-}'}" != extract ]] || exit 9\nexec "${realTar}" "$@"`);
  fs.mkdirSync(path.join(directory, 'System32'));
  // Windows bsdtar reads ZIP, but the host tar may be GNU tar, so the stand-in reads the member with Python.
  fs.writeFileSync(path.join(directory, 'System32/tar.exe'), `#!/bin/bash\necho tar.exe >> "$CALLS"\n[[ "${'${FAILURE:-}'}" != extract ]] || exit 9\n[[ "$1" == -xOf ]] || exit 98\nexec python3 -c 'import sys, zipfile; sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))' "$2" "$3"\n`, { mode: 0o700 });
  mock('tar.exe', 'echo wrong-tar >> "$CALLS"\nexit 99');
  mock('cargo', 'echo "cargo $*" >> "$CALLS"\nexit "${CARGO_EXIT:-0}"');
  return {
    directory, archive, name,
    env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH,
      CI_CARGO_AUDIT_VERSION: '0.22.2', RUNNER_TEMP: directory, GITHUB_PATH: path.join(directory, 'github-path'),
      CALLS: path.join(directory, 'calls'), FIXTURE_ARCHIVE: archive, SYSTEMROOT: directory,
      FIXTURE_OS: 'Linux', FIXTURE_ARCH: 'x86_64', FIXTURE_LIBC: 'gnu' },
  };
};
const run = (f, env = {}) => spawnSync('bash', [path.join(f.directory, 'setup-cargo-audit.sh')], { encoding: 'utf8', env: { ...f.env, ...env } });
const calls = f => fs.existsSync(f.env.CALLS) ? fs.readFileSync(f.env.CALLS, 'utf8') : '';

describe('contract.ci-quality-toolchain.preparation', () => {
  // contract_id: contract.ci-quality-toolchain.preparation
  // integration_id: quality-toolchain-cargo-audit-prebuilt
  test('verified archive is extracted executed and exported without cargo compilation', () => {
    for (const [system, machine, libc, target] of [
      ['Linux', 'x86_64', 'gnu', 'x86_64-unknown-linux-gnu'],
      ['Linux', 'x86_64', 'musl', 'x86_64-unknown-linux-musl'],
      ['Linux', 'aarch64', 'gnu', 'aarch64-unknown-linux-gnu'],
      ['Darwin', 'arm64', '', 'aarch64-apple-darwin'],
      ['Darwin', 'x86_64', '', 'x86_64-apple-darwin'],
      ['MINGW64_NT-10.0', 'x86_64', '', 'x86_64-pc-windows-msvc'],
    ]) {
      const f = fixture(target);
      try {
        const result = run(f, { FIXTURE_OS: system, FIXTURE_ARCH: machine, FIXTURE_LIBC: libc });
        expect(result.status, result.stderr).toBe(0);
        expect(calls(f)).toBe(`curl\n${system.startsWith('MINGW') ? 'tar.exe' : 'tar'}\n`);
        const installed = fs.readFileSync(f.env.GITHUB_PATH, 'utf8').trim();
        expect(fs.readdirSync(installed)).toEqual([target.endsWith('windows-msvc') ? 'cargo-audit.exe' : 'cargo-audit']);
        expect(result.stdout).toContain(`installed verified ${target} binary`);
      } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
    }
  });

  // contract_id: contract.ci-quality-toolchain.preparation
  test('unregistered versions and targets retain source install and its exit status', () => {
    const f = fixture();
    try {
      for (const env of [{ CI_CARGO_AUDIT_VERSION: '0.21.0' }, { FIXTURE_OS: 'MINGW64_NT-10.0', FIXTURE_ARCH: 'aarch64' }, { FIXTURE_ARCH: 'aarch64', FIXTURE_LIBC: 'musl' }]) {
        fs.writeFileSync(f.env.CALLS, '');
        const result = run(f, { ...env, CARGO_EXIT: '17' });
        expect(result.status).toBe(17);
        expect(calls(f)).toBe(`cargo install cargo-audit --locked --version ${env.CI_CARGO_AUDIT_VERSION ?? '0.22.2'}\n`);
        expect(fs.existsSync(f.env.GITHUB_PATH)).toBe(false);
      }
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
  });

  // contract_id: contract.ci-quality-toolchain.preparation
  test('registered asset failures stop without source fallback or PATH output', () => {
    for (const failure of ['checksum', 'download', 'extract', 'version', 'path', 'digest']) {
      const f = fixture();
      try {
        if (failure === 'checksum') fs.appendFileSync(f.archive, 'modified');
        if (failure === 'digest') fs.writeFileSync(path.join(f.directory, 'cargo-audit-sha256sums.txt'), `invalid  ${f.name}\n`);
        const result = run(f, { FAILURE: failure, ...(failure === 'version' ? { BINARY_VERSION: '0.22.1' } : {}),
          ...(failure === 'path' ? { GITHUB_PATH: path.join(f.directory, 'missing/path') } : {}) });
        expect(result.status).not.toBe(0);
        expect(calls(f)).not.toContain('cargo ');
        if (failure === 'checksum' || failure === 'download') expect(calls(f)).not.toContain('tar');
        if (failure === 'digest') expect(calls(f)).toBe('');
        expect(fs.existsSync(f.env.GITHUB_PATH)).toBe(false);
        expect(fs.readdirSync(f.directory).filter(name => name.startsWith('cargo-audit-bin-'))).toEqual([]);
      } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
    }
  });

  // contract_id: contract.ci-quality-toolchain.preparation
  test('invalid cargo-audit version stops before download or source install', () => {
    const f = fixture();
    try {
      for (const version of ['', 'latest', '0.22.2\n', '../0.22.2']) {
        const result = run(f, { CI_CARGO_AUDIT_VERSION: version });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('quality-toolchain-cargo-audit-version-invalid');
        expect(calls(f)).toBe('');
      }
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
  });
});
