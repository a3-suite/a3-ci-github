import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, test, type TestContext } from 'vitest';
import { checkoutLineEndings, fixture, platform, prepareAssembly, python, repository, runDistributedAction, type SupplementalOptionsType } from './standard-installer-fixtures';

describe('standard installer', () => {
  describe('assembly', () => {
    // evidence_role: supplemental
    // flow_id: native-installer-owner-boundary
    // test_level: e2e
    test('verifies a native candidate through the Python assembly boundary', (t) => {
      // Arrange
      const f = fixture(t);
      const authority = JSON.parse(fs.readFileSync(path.join(f.root, 'authority.json'), 'utf8'));
      const driver = 'import json,os,runpy,subprocess,sys\nsys.path.insert(0,os.path.dirname(sys.argv[1]))\nassembly=runpy.run_path(sys.argv[1])\ntry: assembly["run"](json.load(sys.stdin))\nexcept subprocess.CalledProcessError as error:\n sys.stderr.write(error.stderr or "")\n raise';
      const output = path.join(f.root, 'native-output');
      // Act
      const result = spawnSync(python, ['-c', driver, path.join(repository, 'runtime/installer/src/assembly.py')], {
        env: { ...process.env, ...(process.platform === 'win32' ? { PSModulePath: path.join(f.root, 'unavailable-modules') } : {}) },
        cwd: f.root, encoding: 'utf8', input: JSON.stringify({ operation: 'build-platform', sourceRoot: f.root,
          configPath: path.join(f.root, 'installer/assembly.json'), authority, releasePlatforms: [platform],
          standardBuildRoot: path.join(f.root, 'standard'), outputDirectory: output,
          providerRevision: 'a'.repeat(40), assemblyId: 'native-boundary' }),
      });
      // Assert
      expect(result.status, result.stderr).toBe(0);
      expect(fs.existsSync(path.join(output, 'platform-record.json'))).toBe(true);
    });

    // evidence_role: contract
    // contract_id: contract.ci-release-supplemental-asset.outputs
    // flow_id: standard-installer-process-startup
    // test_level: e2e
    for (const surface of ['Action', 'CLI']) test(`distributed ${surface} accepts CRLF checkout through both phases`, (t: TestContext) => {
      // Arrange
      const f = fixture(t);
      checkoutLineEndings(f.root, 'crlf');
      const execute = (options: SupplementalOptionsType): void => {
        const result = surface === 'Action' ? runDistributedAction(f, options).result : spawnSync(process.execPath,
          [path.join(repository, 'runtime/installer/run-installer.mjs'), '--operation', options.operation, '--source-root', f.root,
            '--authority-path', 'authority.json', '--snapshot-path', 'snapshot.json', '--standard-build-root', options.standardBuildRoot,
            ...(options.supplementalBuildRoot ? ['--supplemental-build-root', options.supplementalBuildRoot] : []),
            '--output-directory', options.outputDirectory, '--provider-revision', 'a'.repeat(40)], { encoding: 'utf8' });
        expect(result.status, result.stderr).toBe(0);
      };
      // Act
      execute(f.options);
      execute(prepareAssembly(f));
      // Assert
      expect(fs.existsSync(path.join(f.root, 'handoff/supplemental-manifest.json'))).toBe(true);
    });

    // evidence_role: contract
    // contract_id: contract.ci-release-supplemental-asset.outputs
    // flow_id: standard-installer-process-startup
    // test_level: e2e
    test('executes packaged local CLI with the same fixed boundary', (t) => {
      // Arrange
      const f = fixture(t);
      const args = Object.entries({ operation: 'build-platform', 'source-root': f.root, 'authority-path': 'authority.json', 'snapshot-path': 'snapshot.json', 'standard-build-root': 'standard', 'output-directory': 'platform-output', 'provider-revision': 'a'.repeat(40) }).flatMap(([key, value]) => [`--${key}`, value]);
      // Act
      const result = spawnSync(process.execPath, [path.join(repository, 'runtime/installer/run-installer.mjs'), ...args], { encoding: 'utf8' });
      // Assert
      expect(result.status, result.stderr).toBe(0);
      expect(fs.existsSync(path.join(f.root, 'platform-output/platform-record.json'))).toBe(true);
    });

    // evidence_role: contract
    // contract_id: contract.ci-release-supplemental-asset.outputs
    // flow_id: standard-installer-process-startup
    // test_level: e2e
    test('executes standard mode from the distributed Action and reports verified output', (t) => {
      // Arrange
      const f = fixture(t);
      // Act
      const { result, output } = runDistributedAction(f);
      // Assert
      expect(result.status, result.stderr).toBe(0);
      expect(fs.readFileSync(output, 'utf8')).toContain('status=success');
      expect(fs.readFileSync(output, 'utf8')).toContain('output-directory=platform-output');
      expect(fs.existsSync(path.join(f.root, 'platform-output/candidate/installer-asset-evidence.json'))).toBe(true);
    });

    // evidence_role: contract
    // contract_id: contract.ci-release-supplemental-asset.outputs
    // flow_id: standard-installer-process-startup
    // test_level: e2e
    test('rejects unsupported provider profile without successful Action output or generated assets', (t) => {
      // Arrange
      const f = fixture(t, 'unsupported');
      // Act
      const { result, output } = runDistributedAction(f);
      // Assert
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('standard-installer-failed');
      expect(fs.readFileSync(output, 'utf8')).toBe('');
      expect(fs.existsSync(path.join(f.root, 'platform-output'))).toBe(false);
    });
  });
});
