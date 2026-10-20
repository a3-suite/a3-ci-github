import fs from 'node:fs';
import path from 'node:path';
import { describe, test, expect } from 'vitest';
import { repository, workflow, filesIn, bytesIn, fixture } from "./control-checkout.fixtures.mjs";

describe('release control checkout', () => {
  // contract_id: contract.ci-release-publication-workflow.publication
  // flow_id: release-control-sparse-checkout
  describe('trusted source identity and file scope', () => {
    test.each(['.ci/platforms.yml', 'platforms.yml', 'custom path/platform [literal]*?#!.yml'])('materializes only the declared manifest at the fixed control SHA: %s', (manifest) => {
      // Arrange
      const project = fixture();
      const scope = project.scope(manifest);
      const steps = workflow.jobs.assemble.steps;
      const index = steps.findIndex(entry => entry.uses?.startsWith('actions/checkout@'));
      // Act
      const control = project.checkout(scope.pattern, 'assemble');
      // Assert
      expect(scope.status, scope.stderr).toBe(0);
      expect(steps[index].with['sparse-checkout']).toBe('${{ steps.control-checkout-scope.outputs.pattern }}');
      expect(steps[index].with['sparse-checkout-cone-mode']).toBe(false);
      expect(steps[index + 1].name).toBe('Verify trusted control checkout');
      expect(project.git(control, 'rev-parse', 'HEAD')).toBe(project.controlSha);
      expect(filesIn(control).map(filename => path.relative(control, filename))).toStrictEqual([manifest]);
      expect(fs.readFileSync(path.join(control, manifest), 'utf8')).toBe('platforms: []\n# trusted control\n');
      expect(project.verify(control, project.controlSha).status).toBe(0);
      expect(project.verify(control, project.productSha).status).not.toBe(0);
    });

    test('keeps Git identity and artifact handoffs without product working files for publish', () => {
      // Arrange
      const project = fixture();
      const step = workflow.jobs.publish.steps.find(entry => entry.uses?.startsWith('actions/checkout@'));
      // Act
      const control = project.checkout(step.with['sparse-checkout'], 'publish');
      fs.mkdirSync(path.join(control, 'authority'));
      fs.writeFileSync(path.join(control, 'authority/publication-request.json'), '{}');
      // Assert
      expect(filesIn(control).map(filename => path.relative(control, filename))).toStrictEqual(['authority/publication-request.json']);
      expect(project.verify(control, project.controlSha).status).toBe(0);
      expect(project.verify(control, project.productSha).status).not.toBe(0);
      expect(step.with.repository).toBe('${{ github.repository }}');
      expect(step.with.ref).toBe('${{ github.workflow_sha }}');
      expect(step.with['sparse-checkout-cone-mode']).toBe(false);
    });

    test('avoids fetching and materializing unrelated large product blobs', () => {
      // Arrange
      const project = fixture();
      const publish = workflow.jobs.publish.steps.find(entry => entry.uses?.startsWith('actions/checkout@'));
      const selections = ['', project.scope('.ci/platforms.yml').pattern, publish.with['sparse-checkout']];
      // Act
      const measurements = selections.map((pattern, index) => {
        const start = performance.now();
        const directory = project.checkout(pattern, `measurement-${index}`);
        return {
          elapsedMs: performance.now() - start,
          objectBytes: bytesIn(path.join(directory, '.git/objects')),
          workingBytes: filesIn(directory).reduce((total, filename) => total + fs.statSync(filename).size, 0),
        };
      });
      // Assert
      expect(measurements[0].objectBytes).toBeGreaterThan(2 * 1024 * 1024);
      for (const narrowed of measurements.slice(1)) {
        expect(narrowed.objectBytes).toBeLessThan(measurements[0].objectBytes / 100);
        expect(narrowed.workingBytes).toBeLessThan(100);
      }
      if (process.env.CI_CHECKOUT_MEASUREMENTS) fs.writeFileSync(process.env.CI_CHECKOUT_MEASUREMENTS, JSON.stringify(measurements, null, 2));
    });
  });

  describe('unsupported and missing selections', () => {
    test('preserves full checkout fallback and rejects multiline scope injection', () => {
      // Arrange
      const project = fixture();
      // Act
      const scopes = ['', '/absolute/path.yml', 'windows\\path.yml', 'platforms.yml ', 'platforms.yml\t', 'platforms.yml\u00a0'].map(value => project.scope(value));
      const invalid = project.scope('platforms.yml\n/product/**');
      // Assert
      for (const scope of scopes) expect(scope.pattern).toBe('');
      expect(invalid.status).not.toBe(0);
      for (const [index, manifest] of ['platforms.yml ', 'platforms.yml\t', 'platforms.yml\u00a0'].entries()) {
        const control = project.checkout(project.scope(manifest).pattern, `whitespace-${index}`);
        expect(fs.readFileSync(path.join(control, manifest), 'utf8')).toBe('platforms: []\n# trusted control\n');
      }
    });

    test('does not silently supply another file when the declared manifest is missing', () => {
      // Arrange
      const project = fixture();
      const scope = project.scope('missing.yml');
      // Act
      const control = project.checkout(scope.pattern, 'missing');
      // Assert
      expect(filesIn(control)).toStrictEqual([]);
      expect(() => fs.readFileSync(path.join(control, 'missing.yml'))).toThrow();
      expect(project.verify(control, project.controlSha).status).toBe(0);
    });
  });
});
