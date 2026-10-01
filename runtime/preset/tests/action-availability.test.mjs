import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadRegistry } from '../ci-preset-assets.ts';
import { validateActionAvailability } from '../action-availability.ts';
import { createReport } from '../validation-report.ts';

const fixture = (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a3-ci-github-action-availability-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const report = createReport();
  return { root, report, registry: loadRegistry(report) };
};

// integration_id: preset-action-availability-contract
test('selected pending publication Actions block deployment without disturbing released presets', (t) => {
  const f = fixture(t);
  assert.deepEqual(f.report.mismatches, []);
  validateActionAvailability(f.root, 'release-request', new Set(['release-request']), new Map(), f.registry, f.report);
  assert.deepEqual(f.report.missingSettings, []);
  validateActionAvailability(f.root, 'release-publication', new Set(['release-publication']), new Map(), f.registry, f.report);
  assert.deepEqual(f.report.missingSettings.map((item) => item.path).sort(), ['release-publication:actions.ci-platform-matrix', 'release-publication:actions.ci-quality-adapter', 'release-publication:actions.ci-release-assembly', 'release-publication:actions.ci-release-authority', 'release-publication:actions.ci-release-publication-control', 'release-publication:actions.ci-release-publication-verifier', 'release-publication:actions.ci-release-publisher', 'release-publication:actions.ci-release-supplemental-asset']);
});

// integration_id: preset-actionized-fallback-rejection
test('preflight rejects both retained legacy assembly files and invocations', (t) => {
  const f = fixture(t);
  const entrypoint = '.ci/trusted/ci-release-assemble.sh';
  fs.mkdirSync(path.join(f.root, '.ci/trusted'), { recursive: true });
  fs.writeFileSync(path.join(f.root, entrypoint), '#!/bin/bash\n');
  validateActionAvailability(f.root, 'release-publication', new Set(['release-publication']), new Map(), f.registry, f.report);
  assert.ok(f.report.mismatches.some((item) => item.path === entrypoint));
  const second = createReport();
  const emptyRoot = path.join(f.root, 'without-legacy-file');
  fs.mkdirSync(emptyRoot);
  validateActionAvailability(emptyRoot, 'release-publication', new Set(['release-publication']), new Map([['workflow.yml', { jobs: { assemble: { steps: [{ run: entrypoint }] } } }]]), f.registry, second);
  assert.ok(second.mismatches.some((item) => item.path === entrypoint));
});
