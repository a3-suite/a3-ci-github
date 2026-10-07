import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, describe, expect } from 'vitest';
import { loadRegistry } from '../preset-registry.ts';
import { validateActionAvailability } from '../action-availability.ts';
import { createReport } from '../validation-report.ts';

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
    validateActionAvailability(f.root, 'release-request', new Set(['release-request']), new Map(), f.registry, f.report);
    expect(f.report.missingSettings).toStrictEqual([]);
    validateActionAvailability(f.root, 'release-publication', new Set(['release-publication']), new Map(), f.registry, f.report);
    expect(f.report.missingSettings).toStrictEqual([]);
    for (const id of ['ci-release-assembly', 'ci-release-publisher']) {
      f.registry.actionTargets.find(target => target.id === id).status = 'pending-release';
    }
    validateActionAvailability(f.root, 'release-publication', new Set(['release-publication']), new Map(), f.registry, f.report);
    expect(f.report.missingSettings.map(item => item.path)).toStrictEqual([
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
    for (const entrypoint of entrypoints) {
      // Arrange
      const file = path.join(f.root, entrypoint);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'consumer-owned content\n');
      const report = createReport();
      // Act
      validateActionAvailability(f.root, 'release-publication', new Set(['release-publication']), new Map(), f.registry, report);
      // Assert
      expect(report.mismatches.some(item => item.path === entrypoint), entrypoint).toBe(true);
      expect(fs.readFileSync(file, 'utf8')).toBe('consumer-owned content\n');
      fs.unlinkSync(file);
      for (const step of [{ run: entrypoint }, { env: { REPURPOSED_FILE: entrypoint } }]) {
        const references = createReport();
        const workflows = new Map([['workflow.yml', { jobs: { other: { steps: [step] } } }]]);
        validateActionAvailability(f.root, 'release-publication', new Set(['release-publication']), workflows, f.registry, references);
        expect(references.mismatches.some(item => item.path === entrypoint), entrypoint).toBe(true);
        expect(fs.existsSync(file)).toBe(false);
      }
    }
  });
});
