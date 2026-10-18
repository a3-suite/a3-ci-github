import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, describe, expect } from 'vitest';
import { validateQualityPlatformSelection } from '../quality-validation.ts';
import { root, manifest } from "./quality-platform-selection.fixtures.mjs";

describe("contract.ci-platform-matrix.outputs", () => {
  describe("platform-selection-conformance", () => {
    // evidence_role: contract
    // test_level: e2e
    // flow_id: platform-selection-conformance
    // contract_id: contract.ci-platform-matrix.outputs
    test('platform Action and preflight agree on selection and parser rejection boundaries', () => {
      // Arrange
      fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
      const fixture = fs.mkdtempSync(path.join(root, 'tmp', 'quality-platform-contract-'));
      try {
        fs.mkdirSync(path.join(fixture, '.ci'));
        fs.writeFileSync(path.join(fixture, 'quality.yml'), '');
        const aliasedManifest = (aliases) => 'platforms:\n' + Array.from({ length: aliases + 1 }, (_, index) =>
          `  - id: platform-${index}\n    runner: ${index === 0 ? '&runner ubuntu-24.04' : '*runner'}\n    target: target-${index}\n`).join('');
        const aliasedSelection = (aliases) => 'platforms:\n  - id: &id linux-x64\n' + '  - id: *id\n'.repeat(aliases);
        const cases = [
          [manifest, aliasedSelection(99), false, /duplicated/],
          [manifest, aliasedSelection(100), false, /Excessive alias count/],
          [aliasedManifest(19), 'platforms: [{id: platform-0}]', true],
          [aliasedManifest(20), 'platforms: [{id: platform-0}]', false],
          [manifest, 'platforms: [{id: macos-arm64}]', true],
          [manifest, 'platforms: [{id: macos-arm64}]\nsharedStandardChecks: true', true],
          [manifest, 'sharedStandardChecks: false\nplatforms: [{id: macos-arm64}]', true],
          [manifest, 'platforms: [{id: macos-arm64}]\nsharedStandardChecks: "true"', false, /must be a boolean/],
          [manifest, 'platforms: [{id: macos-arm64}]\nsharedStandardChecks: true\nunknown: false', false],
          [manifest.replace('macos-14', 'macos-15'), 'platforms: [{id: macos-arm64}]', true],
          [manifest, 'platforms: [{id: macos-arm64}, {id: linux-x64}]', true],
          [manifest, 'platforms: []', false],
          [manifest, 'platforms: [{id: linux-x64}, {id: linux-x64}]', false],
          [manifest, 'platforms: [{id: unknown}]', false],
          [manifest, 'platforms: [{id: linux-x64, runner: ubuntu-24.04}]', false],
          [manifest, 'platforms: [{id: 123}]', false],
          [manifest, 'platforms: [{id: linux-x64}]\nextra: true', false],
          [manifest, 'platforms: [{id: linux-x64, id: macos-arm64}]', false],
          [manifest, 'platforms: [{id: linux-x64}]\nplatforms: [{id: macos-arm64}]', false],
          [manifest.replace('macos-14', 'ubuntu-latest'), 'platforms: [{id: linux-x64}]', false],
          [manifest.replace('macos-arm64', 'linux-x64'), 'platforms: [{id: linux-x64}]', false],
          [manifest.replace('aarch64-apple-darwin', 'x86_64-unknown-linux-gnu'), 'platforms: [{id: linux-x64}]', false],
          [manifest.replace('aarch64-apple-darwin', '../invalid'), 'platforms: [{id: linux-x64}]', false],
          [manifest.replace('id: linux-x64', 'id: linux-x64\n    id: duplicate'), 'platforms: [{id: linux-x64}]', false],
          [`platforms:\n${' '.repeat(64 * 1024)}`, 'platforms: [{id: linux-x64}]', false],
          [manifest, 'platforms: [', false],
        ];
        for (const [manifestText, selectionText, accepted, diagnostic] of cases) {
          // Arrange
          fs.writeFileSync(path.join(fixture, '.ci/platforms.yml'), manifestText);
          fs.writeFileSync(path.join(fixture, '.ci/selection.yml'), selectionText);
          const outputPath = path.join(fixture, 'outputs');
          fs.writeFileSync(outputPath, '');
          const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: outputPath,
            'INPUT_MANIFEST-PATH': path.join(fixture, '.ci/platforms.yml'),
            'INPUT_RUNNER-POLICY': 'trusted',
            'INPUT_SELECTION-PATH': path.join(fixture, '.ci/selection.yml') };
          const report = { missingSettings: [], mismatches: [] };
          // Act
          const action = spawnSync(process.execPath, [path.join(root, 'actions/ci-platform-matrix/dist/index.js')], { env, encoding: 'utf8' });
          validateQualityPlatformSelection({ root: fixture, registry: {
            platformManifestPath: '.ci/platforms.yml', qualityPlatformSelectionPath: '.ci/selection.yml',
          }, report }, { id: 'quality-gate', optionalWorkflowAssets: [{ destination: 'quality.yml' }] });
          // Assert
          expect(action.status === 0, `${selectionText}: ${action.stderr}`).toBe(accepted);
          expect(report.missingSettings.length + report.mismatches.length === 0, `${selectionText}: ${JSON.stringify(report)}`).toBe(accepted);
          if (!accepted) expect(fs.readFileSync(outputPath, 'utf8')).toBe('');
          if (diagnostic) {
            expect(action.stderr).toMatch(diagnostic);
            expect(JSON.stringify(report.mismatches)).toMatch(diagnostic);
          }
        }
      } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
    });
  });
});
