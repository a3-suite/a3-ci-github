import path from 'node:path';
import { test, describe, expect } from 'vitest';
import { loadRegistry } from '../preset-registry.ts';
import { validateActionAvailability } from '../action-availability.ts';
import { root } from "./quality-platform-selection.fixtures.mjs";

describe("quality-platform-selection", () => {
  describe("preset-assurance-contract", () => {
    // integration_id: preset-assurance-contract
    test('unreleased quality bundle and optional selection APIs block deployment until fixed releases exist', () => {
      const registryReport = { missingSettings: [], mismatches: [] };
      const registry = loadRegistry(registryReport);
      expect(registryReport).toStrictEqual({ missingSettings: [], mismatches: [] });
      for (const id of ['ci-platform-matrix', 'ci-quality-adapter']) {
        registry.actionTargets.find(target => target.id === id).status = 'pending-release';
      }
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
