import path from 'node:path';
import { describe, test, expect } from 'vitest';
import { workflow } from "./control-checkout.fixtures.mjs";

describe('release control checkout', () => {
  // contract_id: contract.ci-release-publication-workflow.publication
  // integration_id: release-control-sparse-checkout
  describe('trusted source identity and file scope', () => {

    test('removes credentials from the fixed assembly source checkout', () => {
      // Arrange
      const step = workflow.jobs.assemble.steps.find(entry => entry.name === 'Checkout fixed assembly source');
      // Act
      const settings = step.with;
      // Assert
      expect(settings['persist-credentials']).toBe(false);
    });

    // evidence_role: supplemental
    // The path filter settings of the fixed assembly source checkout are a declaration that no mapped contract guarantee observes.
    test('keeps public skill source complete', () => {
      // Arrange
      const step = workflow.jobs.assemble.steps.find(entry => entry.name === 'Checkout fixed assembly source');
      // Act
      const settings = step.with;
      // Assert
      expect(settings.path).toBe('release-source');
      expect(settings.ref).toBe('${{ needs.authority.outputs.source_sha }}');
      expect(settings['sparse-checkout']).toBeUndefined();
      expect(settings.filter).toBeUndefined();
    });
  });
});
