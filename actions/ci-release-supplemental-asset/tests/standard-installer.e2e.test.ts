import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runSupplemental } from '../../../runtime/release-publication/supplemental';
import { releaseErrorMessage } from '../../../runtime/release-publication/io';
import { describe, expect, test, type TestContext } from 'vitest';
import { archiveName, checkoutLineEndings, fixture, platform, prepareAssembly, python, repository, runDistributedAction, type SupplementalOptionsType } from './standard-installer-fixtures';

describe('standard installer', () => {
  describe('assembly', () => {
    // evidence_role: supplemental
    // flow_id: standard-installer-cli-diagnostics
    // test_level: e2e
    test('distributed CLI preserves safe standard installer diagnostics', (t) => {
      // Arrange
      const f = fixture(t);
      fs.writeFileSync(path.join(f.root, 'standard', `${archiveName}.sha256`), 'synthetic-secret');
      // Act
      const result = spawnSync(process.execPath, [path.join(repository, 'runtime/installer/run-installer.mjs'),
        '--operation', f.options.operation, '--source-root', f.root, '--authority-path', 'authority.json',
        '--snapshot-path', 'snapshot.json', '--standard-build-root', f.options.standardBuildRoot,
        '--output-directory', f.options.outputDirectory, '--provider-revision', 'a'.repeat(40)], { encoding: 'utf8' });
      // Assert
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).not.toContain('synthetic-secret');
      const diagnostic = JSON.parse(result.stderr.split('\n').find((line: string) => line.startsWith('standard-installer-failed:'))!.slice('standard-installer-failed:'.length));
      expect(diagnostic.phase).toBe('build-platform');
      expect(diagnostic['sanitized-reason']).toBe('installer-artifact-checksum-invalid');
      expect(diagnostic['exit-status']).toBe(1);
      expect(fs.existsSync(path.join(f.root, 'platform-output/platform-record.json'))).toBe(false);
    });

    // contract_id: contract.ci-failure-diagnostics.actionable
    // flow_id: installer-transfer-diagnostics
    // test_level: e2e
    test('distributed Action diagnoses transferred installer evidence missing or changed', (t) => {
      // Arrange
      const f = fixture(t);
      const build = runDistributedAction(f);
      expect(build.result.status, build.result.stderr).toBe(0);
      const options = prepareAssembly(f);
      const archive = path.join(f.root, options.supplementalBuildRoot!, `supplemental-build-${platform.id}`, 'candidate/.installer-source.zip');
      const bytes = fs.readFileSync(archive);
      for (const mode of ['missing', 'changed']) {
        try {
          if (mode === 'missing') fs.unlinkSync(archive);
          else fs.writeFileSync(archive, 'modified-evidence');
          // Act
          const { result, output } = runDistributedAction(f, { ...options, outputDirectory: `handoff-${mode}` });
          // Assert
          expect(result.status).toBe(1);
          const line = result.stderr.split('\n').find(value => value.startsWith('ci-failure-diagnostic:'))!;
          const evidence = JSON.parse(line.slice('ci-failure-diagnostic:'.length));
          expect(evidence.classification.stage).toBe('standard-installer-execution');
          expect(evidence.comparison.comparison.field).toBe('installer-candidate-files');
          expect(evidence.comparison.comparison[mode]).toEqual(['.installer-source.zip']);
          expect(evidence.comparison['exit-status']).toBe(1);
          expect(evidence['execution-state'].write).toBe('supplemental-output-may-be-partial');
          expect(evidence['evidence-location'].log).toBe('workflow-run-job-step-log');
          expect(evidence['next-check'].stage).toBe('standard-installer-execution');
          expect(fs.readFileSync(output, 'utf8')).toBe('');
          expect(fs.existsSync(path.join(f.root, `handoff-${mode}/supplemental-manifest.json`))).toBe(false);
        } finally { fs.writeFileSync(archive, bytes); }
      }
    });

    // evidence_role: supplemental
    // flow_id: standard-installer-diagnostic-rejection
    // test_level: e2e
    test('standard installer rejects malformed or untrusted process diagnostics', (t) => {
      // Arrange
      const f = fixture(t);
      const installerRoot = path.join(f.root, 'diagnostic-provider');
      fs.mkdirSync(path.join(installerRoot, 'src'), { recursive: true });
      const runner = path.join(installerRoot, 'src/assembly.py');
      for (const value of ['synthetic-secret', JSON.stringify({ phase: 'build-platform', 'sanitized-reason': 'synthetic-secret' }),
        JSON.stringify({ phase: 'assemble', 'sanitized-reason': 'installer-input-invalid' }),
        JSON.stringify({ phase: 'build-platform', 'sanitized-reason': 'installer-input-invalid', token: 'synthetic-secret' })]) {
        fs.writeFileSync(runner, `import sys\nsys.stderr.write(${JSON.stringify(value)})\nsys.exit(23)\n`);
        // Act
        let error: unknown;
        try { runSupplemental({ ...f.options, installerRoot }); } catch (failure) { error = failure; }
        // Assert
        const message = releaseErrorMessage(error);
        expect(message).not.toContain('synthetic-secret');
        const diagnostic = JSON.parse(message.slice('standard-installer-failed:'.length));
        expect(diagnostic.operation).toBe('standard-installer');
        expect(diagnostic.phase).toBe('build-platform');
        expect(diagnostic['sanitized-reason']).toBe('process-failed');
        expect(diagnostic['exit-status']).toBe(23);
        expect(fs.existsSync(path.join(f.root, 'platform-output'))).toBe(false);
      }
    });

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
