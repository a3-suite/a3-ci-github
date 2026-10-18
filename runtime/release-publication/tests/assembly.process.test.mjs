import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, describe, expect } from 'vitest';
import { fixture } from './fixtures.mjs';
import { sha256 } from '../io.ts';
import { spawnTimeoutMs, hasPwsh } from "./assembly.fixtures.mjs";

describe("contract.ci-release-assembly.outputs", () => {
  describe("release-assembly-contract", () => {

    // contract_id: contract.ci-release-assembly.outputs
    // flow_id: release-assembly-contract
    test('assembly accepts PowerShell package output and rejects altered checksum records', { skip: !hasPwsh }, (t) => {
      const platform = { id: 'windows-x64', runner: 'windows-2022', target: 'x86_64-pc-windows-msvc' };
      const f = fixture(t, platform);
      const output = path.join(f.options.buildRoot, `release-build-${platform.id}`);
      fs.rmSync(output, { recursive: true });
      const binary = f.put('project.exe', 'release-binary');
      const script = fileURLToPath(new URL('../../rust-release/package-release.ps1', import.meta.url));

      const packaged = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-File', script,
        binary, 'project.exe', 'project', f.identity.version, platform.id, platform.target, f.identity.source_sha, output,
      ], { encoding: 'utf8', timeout: spawnTimeoutMs });

      expect(packaged.status, packaged.stderr).toBe(0);
      const digest = sha256(fs.readFileSync(path.join(output, f.name)));
      const checksumPath = path.join(output, `${f.name}.sha256`);
      const checksum = fs.readFileSync(checksumPath);
      expect(checksum.equals(Buffer.from(`${digest}  ${f.name}\n`))).toBe(true);
      const result = f.assemble();
      expect(result.assets.map((asset) => asset.name)).toEqual([f.name, `${f.name}.sha256`]);
      expect(fs.readFileSync(path.join(f.options.outputRoot, 'assets', `${f.name}.sha256`)).equals(checksum)).toBe(true);

      for (const [label, record] of [
        ['missing-lf', `${digest}  ${f.name}`],
        ['crlf', `${digest}  ${f.name}\r\n`],
        ['wrong-digest', `${'0'.repeat(64)}  ${f.name}\n`],
      ]) {
        fs.writeFileSync(checksumPath, record);
        f.options.outputRoot = path.join(f.root, label);
        expect(f.assemble).toThrow(/checksum-mismatch/);
        expect(fs.existsSync(f.options.outputRoot)).toBe(false);
      }
    });
  });
});
