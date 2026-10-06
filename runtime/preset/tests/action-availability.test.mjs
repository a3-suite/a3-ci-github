import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, describe, expect } from 'vitest';
import { loadRegistry } from '../preset-registry.ts';
import { validateActionAvailability } from '../action-availability.ts';
import { createReport } from '../validation-report.ts';

const fixture = (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a3-ci-github-action-availability-'));
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
  test('preflight rejects both retained legacy assembly files and invocations', (t) => {
    const f = fixture(t);
    const entrypoint = '.ci/trusted/ci-release-assemble.sh';
    fs.mkdirSync(path.join(f.root, '.ci/trusted'), { recursive: true });
    fs.writeFileSync(path.join(f.root, entrypoint), '#!/bin/bash\n');
    validateActionAvailability(f.root, 'release-publication', new Set(['release-publication']), new Map(), f.registry, f.report);
    expect(f.report.mismatches.some((item) => item.path === entrypoint)).toBeTruthy();
    const second = createReport();
    const emptyRoot = path.join(f.root, 'without-legacy-file');
    fs.mkdirSync(emptyRoot);
    validateActionAvailability(emptyRoot, 'release-publication', new Set(['release-publication']), new Map([['workflow.yml', { jobs: { assemble: { steps: [{ run: entrypoint }] } } }]]), f.registry, second);
    expect(second.mismatches.some((item) => item.path === entrypoint)).toBeTruthy();
  });
});
