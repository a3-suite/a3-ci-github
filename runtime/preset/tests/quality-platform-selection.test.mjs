import fs from 'node:fs';
import path from 'node:path';
import { test, describe, expect } from 'vitest';
import { providerWithActionStatus, validateCiPresetCli } from './support/preset-cli.mjs';
import { root } from "./quality-platform-selection.fixtures.mjs";

describe("quality-platform-selection", () => {
  describe("preset-assurance-contract", () => {
    // integration_id: preset-assurance-contract
    test('unreleased quality bundle and optional selection APIs block deployment until fixed releases exist', (t) => {
      const fixture = fs.mkdtempSync(path.join(root, 'tmp/quality-platform-pending-'));
      t.onTestFinished(() => fs.rmSync(fixture, { recursive: true, force: true }));
      const runtimeRoot = providerWithActionStatus(fixture, { 'ci-platform-matrix': 'pending-release', 'ci-quality-adapter': 'pending-release' });
      const unavailable = (report, id) => report.missingSettings.some((finding) => finding.path === `quality-gate:actions.${id}`
        && finding.message.startsWith('Action is not available'));
      for (const [name, optionalInstalled, pending] of [['required-only', false, false], ['with-platforms', true, true]]) {
        const consumer = path.join(fixture, name);
        fs.mkdirSync(path.join(consumer, '.github/workflows'), { recursive: true });
        // The optional platforms workflow joins the inspected set when its file is installed.
        if (optionalInstalled) fs.writeFileSync(path.join(consumer, '.github/workflows/quality-gate-platforms.yml'), 'name: quality-gate-platforms\n');
        const report = validateCiPresetCli({ repoRoot: consumer, presets: ['quality-gate'], runtimeRoot });
        expect(report.status, name).toBe('failed');
        expect(unavailable(report, 'ci-platform-matrix'), name).toBe(pending);
        expect(unavailable(report, 'ci-quality-adapter'), name).toBe(true);
      }
    });
  });
});
