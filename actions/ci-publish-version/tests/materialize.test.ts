import { strict as assert } from 'node:assert';
import test from 'node:test';
import { materializePublishVersion } from '../src/materialize.js';

const captureFailure = (operation: () => unknown): unknown => {
  try { operation(); } catch (error) { return error; }
  return undefined;
};

// target_id: materializePublishVersion(PublishVersionPlan)
test('materializes an exact version', () => {
  // Arrange
  const plan = { strategy: 'exact', publishVersion: '1.2.3' } as const;
  // Act
  const result = materializePublishVersion(plan);
  // Assert
  assert.equal(result, '1.2.3');
});

// target_id: materializePublishVersion(PublishVersionPlan)
test('materializes a generated version from all referenced components', () => {
  // Arrange
  const plan = {
      strategy: 'ciGenerated',
      template: '{baseVersion}-dev.{build}',
      components: { baseVersion: '1.2.3', build: '42' },
    } as const;
  // Act
  const result = materializePublishVersion(plan);
  // Assert
  assert.equal(result, '1.2.3-dev.42');
});

// target_id: materializePublishVersion(PublishVersionPlan)
test('rejects a missing component', () => {
  // Arrange
  const plan = { strategy: 'ciGenerated', template: '{baseVersion}-{build}', components: { baseVersion: '1.2.3' } } as const;
  // Act
  const failure = captureFailure(() => materializePublishVersion(plan));
  // Assert
  assert.match(String(failure), /publish-version-plan-component-missing/);
});

// target_id: materializePublishVersion(PublishVersionPlan)
test('rejects an unused component', () => {
  // Arrange
  const plan = { strategy: 'ciGenerated', template: '{baseVersion}', components: { baseVersion: '1.2.3', build: '42' } } as const;
  // Act
  const failure = captureFailure(() => materializePublishVersion(plan));
  // Assert
  assert.match(String(failure), /publish-version-plan-component-unused/);
});

// target_id: materializePublishVersion(PublishVersionPlan)
test('rejects unsupported strategies and output-breaking values', () => {
  // Arrange
  const plans = [{ strategy: 'manifestInferred', publishVersion: '1.2.3' }, { strategy: 'exact', publishVersion: '1.2.3\nforged=true' }] as const;
  // Act
  const failures = plans.map((plan) => captureFailure(() => materializePublishVersion(plan)));
  // Assert
  assert.match(String(failures[0]), /publish-version-plan-strategy-invalid/);
  assert.match(String(failures[1]), /publish-version-plan-exact-version-invalid/);
});
