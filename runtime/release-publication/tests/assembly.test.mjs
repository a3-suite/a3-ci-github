import fs from 'node:fs';
import path from 'node:path';
import childProcess, { execFileSync, spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { test, vi, describe, expect } from 'vitest';
import { fixture, releaseSkillsFixture, selectedReleaseSkillsFixture } from './fixtures.mjs';
import { sha256, canonicalJson } from '../io.ts';
import { validateEvidence } from '../schema.ts';
import { loadAssembly } from '../observation.ts';
import skillPolicy from '../skill-package-policy.json';
import { spawnTimeoutMs } from "./assembly.fixtures.mjs";

describe('contract.ci-release-assembly.outputs', () => {
  describe('same-release-skills', () => {
    // contract_id: contract.ci-release-assembly.outputs
    // integration_id: same-release-skills
    test('skills exceed former individual limits', (t) => {
      const f = releaseSkillsFixture(t, (config, root) => {
        for (let index = 0; index < 65; index++) {
          const directory = `skills/sdd/tool-${index}`;
          fs.mkdirSync(path.join(root, directory), { recursive: true });
          fs.writeFileSync(path.join(root, directory, 'SKILL.md'), `---\nname: tool-${index}\ndescription: Public tool.\n---\n`);
          config.skills.push({ path: directory, include: ['SKILL.md'], requiredFiles: ['SKILL.md'] });
        }
        const assets = path.join(root, 'skills/example-tool/assets');
        fs.writeFileSync(path.join(assets, 'large.bin'), Buffer.alloc(8 * 1024 * 1024 + 1));
        for (let index = 0; index < 1025; index++) fs.writeFileSync(path.join(assets, `item-${index}.txt`), 'data');
      });
      f.assemble();
      const owner = JSON.parse(fs.readFileSync(path.join(f.options.outputRoot, 'evidence/evidence-4-project-skills.zip.owner.json'), 'utf8'));
      expect(new Set(owner.files.map(entry => entry.path.split('/')[0])).size).toBe(66);
      expect(owner.files.length).toBeGreaterThan(1024);
      expect(owner.files.find(entry => entry.path.endsWith('/large.bin')).size).toBeGreaterThan(8 * 1024 * 1024);
    });
    // contract_id: contract.ci-release-assembly.outputs
    // integration_id: same-release-skills
    test('skills retain the aggregate size boundary', (t) => {
      const boundary = releaseSkillsFixture(t);
      boundary.assemble();
      const boundaryOwner = JSON.parse(fs.readFileSync(path.join(boundary.options.outputRoot, 'evidence/evidence-4-project-skills.zip.owner.json'), 'utf8'));
      const total = boundaryOwner.files.reduce((sum, entry) => sum + entry.size, 0);
      const originalLimit = skillPolicy.maximumTotalBytes;
      try {
        skillPolicy.maximumTotalBytes = total;
        boundary.options.outputRoot = path.join(boundary.root, 'at-total-limit');
        expect(boundary.assemble).not.toThrow();
        skillPolicy.maximumTotalBytes = total - 1;
        boundary.options.outputRoot = path.join(boundary.root, 'over-total-limit');
        expect(boundary.assemble).toThrow(/skills-size-invalid/);
        expect(fs.existsSync(boundary.options.outputRoot)).toBe(false);
      } finally {
        skillPolicy.maximumTotalBytes = originalLimit;
      }
    });
    // contract_id: contract.ci-release-assembly.outputs
    // integration_id: same-release-skills
    test('skills report an invalid SKILL.md before an unreadable later blob', (t) => {
      // Arrange
      const f = releaseSkillsFixture(t, (config, root) => {
        fs.writeFileSync(path.join(root, 'skills/example-tool/SKILL.md'), 'no frontmatter here\n');
      });
      const oid = execFileSync('git', ['-C', f.root, 'rev-parse', 'HEAD:skills/example-tool/references/setup.guide.md'], { encoding: 'utf8', timeout: spawnTimeoutMs }).trim();
      fs.rmSync(path.join(f.root, '.git/objects', oid.slice(0, 2), oid.slice(2)));
      // Act and Assert
      expect(f.assemble).toThrow(/skills-entry-invalid/);
    });
    // contract_id: contract.ci-release-assembly.outputs
    // integration_id: same-release-skills
    test('skills report an invalid SKILL.md even when the read-ahead batch fails', (t) => {
      // Arrange
      const f = releaseSkillsFixture(t, (config, root) => {
        fs.writeFileSync(path.join(root, 'skills/example-tool/SKILL.md'), 'no frontmatter here\n');
      });
      const original = childProcess.execFileSync;
      childProcess.execFileSync = (command, args, ...rest) => {
        if (Array.isArray(args) && args.includes('cat-file') && args.includes('--batch')) throw new Error('simulated batch failure');
        return original(command, args, ...rest);
      };
      syncBuiltinESMExports();
      try {
        // Act and Assert
        expect(f.assemble).toThrow(/skills-entry-invalid/);
      } finally {
        childProcess.execFileSync = original;
        syncBuiltinESMExports();
      }
    });
    // contract_id: contract.ci-release-assembly.outputs
    // integration_id: same-release-skills
    test('skills preserve fixed source bytes and reject incomplete or unsafe packages', (t) => {
      // Arrange
      const f = releaseSkillsFixture(t);
      f.put('skills/example-tool/scripts/run.py', 'dirty checkout is not release source');
      // Act
      const result = f.assemble();
      const zipPath = path.join(f.options.outputRoot, 'assets/project-skills.zip');
      const inspected = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c',
        'import sys,io,zipfile,json,hashlib; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); assert z.testzip() is None; print(json.dumps([{ "path":i.filename,"size":i.file_size,"sha256":hashlib.sha256(z.read(i)).hexdigest(),"mode":i.external_attr >> 16} for i in z.infolist()]))'],
        { input: fs.readFileSync(zipPath), encoding: 'utf8', timeout: spawnTimeoutMs });
      // Assert
      expect(inspected.status, inspected.stderr).toBe(0);
      const inventory = JSON.parse(inspected.stdout);
      expect(inventory.find(entry => entry.path === 'example-tool/scripts/run.py').mode).toBe(0o100755);
      expect(inventory.map(entry => entry.path)).toEqual(['example-tool/SKILL.md', 'example-tool/assets/example.txt', 'example-tool/references/setup.guide.md', 'example-tool/scripts/__init__.py', 'example-tool/scripts/_helper.py', 'example-tool/scripts/run.py', 'example-tool/scripts/runtime.js']);
      const owner = JSON.parse(fs.readFileSync(path.join(f.options.outputRoot, 'evidence/evidence-4-project-skills.zip.owner.json'), 'utf8'));
      expect(owner).toMatchObject({ owner_contract: 'ci.release-skills-package', source_sha: f.identity.source_sha, version: f.identity.version });
      expect(owner.files).toEqual(inventory.map(({ mode, ...entry }) => entry));
      expect(owner.asset_sha256).toBe(sha256(fs.readFileSync(zipPath)));
      expect(result.assets).toHaveLength(4);
      expect(loadAssembly({ ...f.options, handoffRoot: f.options.outputRoot }).assembly.asset_digest).toBe(result.asset_digest);
      f.options.outputRoot = path.join(f.root, 'repeated');
      f.assemble();
      expect(fs.readFileSync(path.join(f.options.outputRoot, 'assets/project-skills.zip'))).toEqual(fs.readFileSync(zipPath));
      fs.appendFileSync(path.join(f.options.outputRoot, 'assets/project-skills.zip'), 'changed');
      expect(() => loadAssembly({ ...f.options, handoffRoot: f.options.outputRoot })).toThrow();

      const chosen = selectedReleaseSkillsFixture(t);
      chosen.put('SKILL.md', 'dirty source must not change the selected name');
      chosen.assemble();
      const chosenOwner = JSON.parse(fs.readFileSync(path.join(chosen.options.outputRoot, 'evidence/evidence-4-project-skills.zip.owner.json'), 'utf8'));
      expect(chosenOwner.files.map(entry => entry.path)).toEqual(['child-tool/SKILL.md', 'nested-tool/SKILL.md', 'root-tool/SKILL.md', 'sdd/SKILL.md']);

      const largeRepository = releaseSkillsFixture(t, (config, root) => {
        fs.writeFileSync(path.join(root, 'SKILL.md'), '---\nname: root-tool\ndescription: Root skill in a large repository.\n---\n');
        config.skills = [{ path: '.', include: ['SKILL.md'], requiredFiles: ['SKILL.md'] }];
      }, git => {
        const blob = git(['rev-parse', ':SKILL.md']);
        const unselected = Array.from({ length: 7000 }, (_, index) => `100644 blob ${blob}\t${String(index).padStart(5, '0')}-${'x'.repeat(100)}.txt\n`).join('');
        const tree = git(['mktree'], unselected);
        git(['read-tree', '--prefix=unselected/', tree]);
      });
      largeRepository.assemble();
      const largeOwner = JSON.parse(fs.readFileSync(path.join(largeRepository.options.outputRoot, 'evidence/evidence-4-project-skills.zip.owner.json'), 'utf8'));
      expect(largeOwner.files.map(entry => entry.path)).toEqual(['root-tool/SKILL.md']);

      for (const [label, mutate, reason] of [
        ['required missing', config => config.skills[0].requiredFiles.push('scripts/missing.py'), /skills-required-file-missing/],
        ['required excluded', config => config.skills[0].requiredFiles.push('scripts/tmp/residual.py'), /skills-required-file-missing/],
        ['include missing', config => config.skills[0].include.push('missing'), /skills-include-missing/],
        ['traversal', config => config.skills[0].include.push('../private'), /skills-path-invalid/],
        ['drive path', config => config.skills[0].include.push('C:/private'), /skills-path-invalid/],
        ['reserved device', config => config.skills[0].include.push('scripts/CON.txt'), /skills-path-invalid/],
        ['duplicate root', config => config.skills.push(config.skills[0]), /skills-root-invalid/],
        ['unknown field', config => config.unknown = true, /skills-declaration-invalid/],
        ['missing SKILL', config => config.skills[0].include = ['scripts'], /skills-required-file-missing/],
        ['root absolute', config => config.skills[0].path = '/private', /skills-path-invalid/],
        ['root drive', config => config.skills[0].path = 'C:/private', /skills-path-invalid/],
        ['root backslash', config => config.skills[0].path = 'skills\\example-tool', /skills-path-invalid/],
        ['root escape', config => config.skills[0].path = '../private', /skills-path-invalid/],
        ['undeclared reference', (config, root) => fs.appendFileSync(path.join(root, 'skills/example-tool/SKILL.md'), '\nSee [required](references/missing.md).\n'), /skills-reference-missing/],
        ['undeclared script', (config, root) => fs.appendFileSync(path.join(root, 'skills/example-tool/SKILL.md'), '\nUse `python scripts/missing.py`.\n'), /skills-reference-missing/],
        ['invalid entry name', (config, root) => fs.writeFileSync(path.join(root, 'skills/example-tool/SKILL.md'), '---\nname: Invalid Name\ndescription: Invalid identity.\n---\n'), /skills-entry-invalid/],

      ]) {
        const invalid = releaseSkillsFixture(t, mutate);
        expect(invalid.assemble, label).toThrow(reason);
        expect(fs.existsSync(invalid.options.outputRoot), label).toBe(false);
      }
      for (const [mode, reason] of [['100644', /skills-file-name-collision/], ['120000', /skills-file-kind-invalid/]]) {
        const invalid = releaseSkillsFixture(t, () => {}, git => {
          const blob = git(['rev-parse', ':skills/example-tool/scripts/run.py']);
          git(['update-index', '--add', '--cacheinfo', `${mode},${blob},skills/example-tool/scripts/RUN.py`]);
        });
        expect(invalid.assemble).toThrow(reason);
        expect(fs.existsSync(invalid.options.outputRoot)).toBe(false);
      }
      const duplicateName = releaseSkillsFixture(t, (config, root) => {
        fs.mkdirSync(path.join(root, 'another'), { recursive: true });
        fs.copyFileSync(path.join(root, 'skills/example-tool/SKILL.md'), path.join(root, 'another/SKILL.md'));
        config.skills.push({ path: 'another', include: ['SKILL.md'], requiredFiles: ['SKILL.md'] });
      });
      expect(duplicateName.assemble).toThrow(/skills-file-name-collision/);
      const linkedEntry = releaseSkillsFixture(t, () => {}, git => {
        const blob = git(['rev-parse', ':skills/example-tool/SKILL.md']);
        git(['update-index', '--cacheinfo', `120000,${blob},skills/example-tool/SKILL.md`]);
      });
      expect(linkedEntry.assemble).toThrow(/skills-file-kind-invalid/);

      const conflictingDirectory = releaseSkillsFixture(t, () => {}, git => {
        const blob = git(['rev-parse', ':skills/example-tool/scripts/run.py']);
        git(['update-index', '--add', '--cacheinfo', `100644,${blob},skills/example-tool/scripts/RUN.py/child.py`]);
      });
      expect(conflictingDirectory.assemble).toThrow(/skills-file-name-collision/);
      expect(fs.existsSync(conflictingDirectory.options.outputRoot)).toBe(false);

      const compiledRuntime = releaseSkillsFixture(t, (config, root) => {
        fs.writeFileSync(path.join(root, 'skills/example-tool/scripts/Main.class'), 'required compiled runtime');
        config.skills[0].requiredFiles.push('scripts/Main.class');
      });
      compiledRuntime.assemble();
      const compiledOwner = JSON.parse(fs.readFileSync(path.join(compiledRuntime.options.outputRoot, 'evidence/evidence-4-project-skills.zip.owner.json'), 'utf8'));
      expect(compiledOwner.files.map(entry => entry.path)).toContain('example-tool/scripts/Main.class');

      const combined = releaseSkillsFixture(t);
      combined.snapshot.values.CI_SUPPLEMENTAL_RELEASE_ASSET_ENABLED = 'true';
      combined.snapshot.values.CI_SUPPLEMENTAL_RELEASE_ASSET_OWNER_CONTRACT = 'installer.asset-evidence';
      combined.snapshot.digest = sha256(Buffer.from(canonicalJson({ sources: combined.snapshot.sources, values: combined.snapshot.values })));
      combined.authority.config_snapshot_digest = combined.snapshot.digest;
      combined.put('snapshot.json', combined.snapshot);
      combined.put('authority.json', combined.authority);
      const payload = Buffer.from('verified installer');
      const installerDigest = sha256(payload);
      const evidence = Buffer.from('installer-owned proof');
      const provenance = Buffer.from('installer-owned provenance');
      combined.put('supplemental/install.ps1', payload);
      combined.put('supplemental/install.ps1.sha256', `${installerDigest}  install.ps1\n`);
      combined.put('supplemental/owner.json', evidence);
      combined.put('supplemental/provenance.json', provenance);
      combined.put('supplemental/verification.json', { status: 'success', owner_contract: 'installer.asset-evidence', source_sha: combined.identity.source_sha, asset_sha256: installerDigest, owner_evidence_sha256: sha256(evidence), provenance_sha256: sha256(provenance) });
      combined.put('supplemental/supplemental-manifest.json', { schema_version: '1', kind: 'ci-github-supplemental-handoff', owner_contract: 'installer.asset-evidence', source_sha: combined.identity.source_sha, version: combined.identity.version, assets: [{ path: 'install.ps1', sha256: installerDigest, checksum_path: 'install.ps1.sha256', owner_evidence_path: 'owner.json', owner_evidence_sha256: sha256(evidence), provenance_path: 'provenance.json', verification_path: 'verification.json' }] });
      combined.options.supplementalRoot = path.join(combined.root, 'supplemental');
      const together = combined.assemble();
      expect(together.assets).toHaveLength(6);
      const records = fs.readdirSync(path.join(combined.options.outputRoot, 'evidence'));
      expect(records).toHaveLength(6);
      expect(fs.readFileSync(path.join(combined.options.outputRoot, 'evidence', records.find(name => name.endsWith('-owner.json'))))).toEqual(evidence);
      expect(JSON.parse(fs.readFileSync(path.join(combined.options.outputRoot, 'evidence', records.find(name => name.endsWith('skills.zip.owner.json'))), 'utf8')).owner_contract).toBe('ci.release-skills-package');
      expect(loadAssembly({ ...combined.options, handoffRoot: combined.options.outputRoot }).assembly.asset_digest).toBe(together.asset_digest);

      const wrongSource = releaseSkillsFixture(t, (config, root) => fs.writeFileSync(path.join(root, 'skills/example-tool/assets/example.txt'), 'different source'));
      wrongSource.options.skillsSourceRoot = f.root;
      expect(wrongSource.assemble).toThrow(/skills-source-mismatch/);
      expect(fs.existsSync(wrongSource.options.outputRoot)).toBe(false);
    });
  });
});


describe("contract.ci-release-assembly.outputs", () => {
  describe("release-assembly-contract", () => {
    // contract_id: contract.ci-release-assembly.outputs
    // integration_id: release-assembly-contract
    test('assembly produces a bound handoff and rejects invalid build inputs', (t) => {
      const f = fixture(t, { id: 'linux', runner: 'ubuntu-22.04', target: 'x86_64-unknown-linux-gnu' });
      const result = f.assemble();
      expect(result.assets.length).toBe(2);
      expect(result.identity.source_sha).toBe(f.identity.source_sha);
      expect(loadAssembly({ ...f.options, handoffRoot: f.options.outputRoot }).assembly.asset_digest).toBe(result.asset_digest);
      expect(f.assemble).toThrow(/filesystem-eexist/);
      const digest = sha256(fs.readFileSync(path.join(f.options.buildRoot, 'release-build-linux', f.name)));
      const checksumPath = path.join(f.options.buildRoot, 'release-build-linux', `${f.name}.sha256`);
      const records = [
        ['missing-lf', `${digest}  ${f.name}`],
        ['crlf', `${digest}  ${f.name}\r\n`],
        ['bom', `\uFEFF${digest}  ${f.name}\n`],
        ['single-space', `${digest} ${f.name}\n`],
        ['wrong-digest', `${'0'.repeat(64)}  ${f.name}\n`],
      ];
      for (const [label, record] of records) {
        // Arrange
        fs.writeFileSync(checksumPath, record);
        f.options.outputRoot = path.join(f.root, label);
        // Act
        const assemble = () => f.assemble();
        // Assert
        expect(assemble, label).toThrow(/checksum-mismatch/);
        expect(fs.existsSync(f.options.outputRoot), label).toBe(false);
      }
    });

    // contract_id: contract.ci-release-assembly.outputs
    // integration_id: release-assembly-contract
    test('asset digest preserves producer bytes and ignores JSON key order', (t) => {
      const f = fixture(t);
      const result = f.assemble();
      const originalDigest = sha256(Buffer.from(JSON.stringify(result.assets)));
      expect(result.asset_digest).toBe(originalDigest);
      const reordered = { ...result, assets: result.assets.map(({ name, sha256: digest, size }) => ({ size, sha256: digest, name })) };
      f.put('handoff/assembly.json', reordered);
      expect(loadAssembly({ ...f.options, handoffRoot: f.options.outputRoot }).assembly.asset_digest).toBe(originalDigest);
      for (const [field, value] of [['name', 'changed.tar.gz'], ['sha256', '0'.repeat(64)], ['size', result.assets[0].size + 1]]) {
        f.put('handoff/assembly.json', { ...result, assets: result.assets.map((asset, index) => index === 0 ? { ...asset, [field]: value } : asset) });
        expect(() => loadAssembly({ ...f.options, handoffRoot: f.options.outputRoot })).toThrow(/asset-set-mismatch/);
      }
    });
  });
});


describe("assembly", () => {
  describe("assembly", () => {
    for (const [label, mutate, error] of [
      ['source', (f) => { f.buildManifest.source_sha = 'c'.repeat(40); f.put('build/release-build-linux/asset-manifest.json', f.buildManifest); }, /source-identity-mismatch/],
      ['version', (f) => { f.buildManifest.version = '2.0.0'; f.put('build/release-build-linux/asset-manifest.json', f.buildManifest); }, /version-mismatch/],
      ['platform', (f) => { f.options.platformMatrix = JSON.stringify({ include: [{ id: 'other', runner: 'ubuntu-24.04', target: 'other' }] }); }, /platform-mismatch/],
      ['checksum', (f) => { f.put(`build/release-build-linux/${f.name}`, 'changed'); }, /checksum-mismatch/],
      ['extra file', (f) => { f.put('build/release-build-linux/extra', 'extra'); }, /asset-set-mismatch/],
      ['symlink', (f) => { fs.unlinkSync(path.join(f.root, 'build/release-build-linux', f.name)); fs.symlinkSync(f.options.authorityPath, path.join(f.root, 'build/release-build-linux', f.name)); }, /symlink-forbidden/],
      ['traversal', (f) => { f.buildManifest.assets[0].path = '../archive'; f.put('build/release-build-linux/asset-manifest.json', f.buildManifest); }, /asset-set-mismatch|asset-name-invalid/],
      ['snapshot', (f) => { f.snapshot.values.CI_SUPPLEMENTAL_RELEASE_ASSET_ENABLED = 'true'; f.put('snapshot.json', f.snapshot); }, /config-inconsistent/],
      ['unexpected supplemental', (f) => { f.options.supplementalRoot = f.root; }, /unexpected-supplemental-asset/],
    ]) {
      // contract_id: contract.ci-release-assembly.outputs
      // integration_id: release-assembly-rejection
      test(`assembly fails closed: ${label}`, (t) => {
        const f = fixture(t);
        mutate(f);
        expect(f.assemble).toThrow(error);
        expect(fs.existsSync(f.options.outputRoot)).toBe(false);
      });
    }
  });
});


describe("contract.ci-release-assembly.outputs", () => {
  describe("release-supplemental-evidence-binding", () => {
    // contract_id: contract.ci-release-assembly.outputs
    // integration_id: release-supplemental-evidence-binding
    test('supplemental evidence binds opaque owner records and rejects mismatches', (t) => {
      const f = fixture(t);
      f.snapshot.values.CI_SUPPLEMENTAL_RELEASE_ASSET_ENABLED = 'true';
      f.snapshot.values.CI_SUPPLEMENTAL_RELEASE_ASSET_OWNER_CONTRACT = 'installer.asset-evidence';
      f.snapshot.digest = sha256(Buffer.from(canonicalJson({ sources: f.snapshot.sources, values: f.snapshot.values })));
      f.authority.config_snapshot_digest = f.snapshot.digest;
      f.put('snapshot.json', f.snapshot);
      f.put('authority.json', f.authority);
      const asset = { path: 'installer.sh', sha256: sha256(Buffer.from('installer')), checksum_path: 'installer.sh.sha256', owner_evidence_path: 'owner.json', owner_evidence_sha256: sha256(Buffer.from('opaque owner record')), provenance_path: 'provenance.json', verification_path: 'verification.json' };
      f.put('supplemental/installer.sh', 'installer');
      f.put('supplemental/installer.sh.sha256', `${asset.sha256}  installer.sh\n`);
      f.put('supplemental/owner.json', 'opaque owner record');
      f.put('supplemental/provenance.json', 'opaque provenance');
      const attestation = { status: 'success', owner_contract: 'installer.asset-evidence', source_sha: f.identity.source_sha, asset_sha256: asset.sha256, owner_evidence_sha256: asset.owner_evidence_sha256, provenance_sha256: sha256(Buffer.from('opaque provenance')) };
      f.put('supplemental/verification.json', attestation);
      f.put('supplemental/supplemental-manifest.json', { schema_version: '1', kind: 'ci-github-supplemental-handoff', owner_contract: attestation.owner_contract, source_sha: f.identity.source_sha, version: f.identity.version, assets: [asset] });
      f.options.supplementalRoot = path.join(f.root, 'supplemental');
      f.put('supplemental/owner.json', 'changed');
      expect(f.assemble).toThrow(/supplemental-asset-evidence-mismatch/);
      f.put('supplemental/owner.json', 'opaque owner record');
      const result = f.assemble();
      expect(result.assets.length).toBe(4);
      expect(fs.readdirSync(path.join(f.options.outputRoot, 'evidence')).length).toBe(3);

      for (const target of ['owner.json', 'provenance.json', 'verification.json']) {
        f.put('supplemental/owner.json', 'opaque owner record');
        f.put('supplemental/provenance.json', 'opaque provenance');
        const verificationPath = f.put('supplemental/verification.json', attestation);
        f.options.outputRoot = path.join(f.root, `changed-${target}`);
        const read = fs.readFileSync;
        let changed = false;
        const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((file, options) => {
          const bytes = read(file, options);
          if (String(file) === verificationPath && !changed) {
            changed = true;
            f.put(`supplemental/${target}`, 'unverified replacement');
          }
          return bytes;
        });
        try {
          expect(f.assemble).toThrow(/checksum-mismatch/);
        } finally {
          spy.mockRestore();
        }
        expect(changed).toBe(true);
        expect(fs.existsSync(path.join(f.options.outputRoot, 'assembly.json'))).toBe(false);
        expect(fs.existsSync(path.join(f.options.outputRoot, 'handoff.json'))).toBe(false);
        expect(fs.readFileSync(path.join(f.options.supplementalRoot, target), 'utf8')).toBe('unverified replacement');
      }
    });
  });
});


describe("contract.ci-release-assembly.outputs", () => {
  describe("release-assembly-shape", () => {
    // contract_id: contract.ci-release-assembly.outputs
    // integration_id: release-assembly-shape
    test('evidence schema rejects unknown fields, missing fields and oversized inventories', () => {
      expect(() => validateEvidence('identity', {})).toThrow(/schema-mismatch/);
      expect(() => validateEvidence('asset', { name: 'a', sha256: 'a'.repeat(64), size: 1, extra: true })).toThrow(/schema-mismatch/);
      expect(() => validateEvidence('assets', Array.from({ length: 257 }, () => ({ name: 'a', sha256: 'a'.repeat(64), size: 1 })))).toThrow(/schema-mismatch/);
    });
  });
});
