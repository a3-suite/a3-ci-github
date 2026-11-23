import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, describe, expect } from 'vitest';
import { loadRegistry } from '../preset-registry.ts';
import { createReport } from '../validation-report.ts';
import { providerWithActionStatus, validateCiPresetCli } from './support/preset-cli.mjs';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const fixture = (t) => {
  const parent = new URL('../../../tmp/', import.meta.url);
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(fileURLToPath(parent), 'a3-ci-github-action-availability-'));
  t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const report = createReport();
  return { root, report, registry: loadRegistry(report) };
};

describe("preset-action-availability-contract", () => {
  // integration_id: preset-action-availability-contract
  test('selected pending publication Actions block deployment without disturbing released presets', (t) => {
    const f = fixture(t);
    expect(f.report.mismatches).toStrictEqual([]);
    const unavailable = (report) => report.missingSettings.filter((item) => item.message.startsWith('Action is not available')).map((item) => item.path);
    const install = (name, preset, source) => {
      const consumer = path.join(f.root, name);
      const workflow = f.registry.presets.find((entry) => entry.id === preset).workflowAssets.find((asset) => asset.source === source);
      fs.mkdirSync(path.dirname(path.join(consumer, workflow.destination)), { recursive: true });
      fs.copyFileSync(path.join(repositoryRoot, workflow.source), path.join(consumer, workflow.destination));
      return consumer;
    };
    const request = install('request', 'release-request', 'workflows/release/release-request-tag.yml');
    const publication = install('publication', 'release-publication', 'workflows/release/release-publication-caller.yml');
    expect(unavailable(validateCiPresetCli({ repoRoot: request, presets: ['release-request'] }))).toStrictEqual([]);
    expect(unavailable(validateCiPresetCli({ repoRoot: publication, presets: ['release-publication'] }))).toStrictEqual([]);
    const runtimeRoot = providerWithActionStatus(f.root, { 'ci-release-assembly': 'pending-release', 'ci-release-publisher': 'pending-release' });
    expect(unavailable(validateCiPresetCli({ repoRoot: request, presets: ['release-request'], runtimeRoot }))).toStrictEqual([]);
    expect(unavailable(validateCiPresetCli({ repoRoot: publication, presets: ['release-publication'], runtimeRoot }))).toStrictEqual([
      'release-publication:actions.ci-release-assembly',
      'release-publication:actions.ci-release-publisher',
    ]);
  });
});

describe("preset-actionized-fallback-rejection", () => {
  // integration_id: preset-actionized-fallback-rejection
  test('preflight rejects all retired Release entrypoints and references without modifying the consumer', (t) => {
    const f = fixture(t);
    const entrypoints = [
      '.ci/trusted/ci-release-authority.sh', '.ci/scripts/ci-source-gate.sh',
      '.ci/scripts/ci-release-build.sh', '.ci/trusted/ci-release-assemble.sh',
      '.ci/trusted/ci-release-publish.sh',
    ];
    expect(f.registry.retiredProjectEntrypoints['release-publication']).toStrictEqual(entrypoints);
    const retained = (report, entrypoint) => [...report.missingSettings, ...report.mismatches].some((item) => item.path === entrypoint
      && item.message === 'Actionized processing must not retain a registered project-local fallback or invocation');
    const caller = path.join(f.root, '.github/workflows/release-publication-caller.yml');
    for (const entrypoint of entrypoints) {
      // Arrange
      const file = path.join(f.root, entrypoint);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'consumer-owned content\n');
      // Act
      const report = validateCiPresetCli({ repoRoot: f.root, presets: ['release-publication'] });
      // Assert
      expect(report.status, entrypoint).toBe('failed');
      expect(retained(report, entrypoint), entrypoint).toBe(true);
      expect(fs.readFileSync(file, 'utf8')).toBe('consumer-owned content\n');
      fs.unlinkSync(file);
      for (const step of [{ run: entrypoint }, { env: { REPURPOSED_FILE: entrypoint } }]) {
        fs.mkdirSync(path.dirname(caller), { recursive: true });
        fs.writeFileSync(caller, JSON.stringify({ jobs: { other: { steps: [step] } } }));
        const references = validateCiPresetCli({ repoRoot: f.root, presets: ['release-publication'] });
        expect(retained(references, entrypoint), entrypoint).toBe(true);
        expect(fs.existsSync(file)).toBe(false);
        fs.unlinkSync(caller);
      }
    }
  });
});
