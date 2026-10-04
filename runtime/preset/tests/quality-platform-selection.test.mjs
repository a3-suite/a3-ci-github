import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, describe, expect } from 'vitest';
import { loadRegistry } from '../preset-registry.ts';
import { validateActionAvailability } from '../action-availability.ts';
import { validateQualityPlatformSelection } from '../quality-validation.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const manifest = `platforms:
  - id: linux-x64
    runner: ubuntu-24.04
    target: x86_64-unknown-linux-gnu
  - id: macos-arm64
    runner: macos-14
    target: aarch64-apple-darwin
`;

describe("contract.ci-platform-matrix.outputs", () => {
  describe("platform-selection-conformance", () => {
    // evidence_role: contract
    // test_level: integration
    // integration_id: platform-selection-conformance
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

describe("quality-platform-selection", () => {
  describe("preset-assurance-contract", () => {
    // integration_id: preset-assurance-contract
    test('unreleased quality bundle and optional selection APIs block deployment until fixed releases exist', () => {
      const registryReport = { missingSettings: [], mismatches: [] };
      const registry = loadRegistry(registryReport);
      expect(registryReport).toStrictEqual({ missingSettings: [], mismatches: [] });
      for (const [workflowIds, pending] of [
        [new Set(['quality-gate']), false],
        [new Set(['quality-gate', 'quality-gate-platforms']), true],
      ]) {
        const report = { missingSettings: [], mismatches: [] };
        validateActionAvailability(root, 'quality-gate', workflowIds, new Map(), registry, report);
        expect(report.missingSettings.some((finding) => finding.path === 'quality-gate:actions.ci-platform-matrix')).toBe(pending);
        expect(report.missingSettings.some((finding) => finding.path === 'quality-gate:actions.ci-quality-adapter')).toBeTruthy();
      }
    });
  });
});
