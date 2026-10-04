import { describe, test, expect } from 'vitest';
import { verifyWorkflowIdentity } from '../src/identity.js';

const SHA = '3407e7b799c2c1f8726fc88a7b997aa4a23eac1a';
const OTHER_SHA = 'cc747e69c63a52dc2a3db336ce269a4df6303ffe';

const base = () => ({
  repository: 'a3-suite/a3-rust-cruiser',
  defaultBranch: 'main',
  expectedCallerWorkflowPath: '.github/workflows/release-publication-caller.yml',
  expectedCalledWorkflowPath: '.github/workflows/release-publication.yml',
  callerWorkflowRef: 'a3-suite/a3-rust-cruiser/.github/workflows/release-publication-caller.yml@refs/heads/main',
  callerWorkflowSha: SHA,
  calledWorkflowRepository: 'a3-suite/a3-rust-cruiser',
  calledWorkflowFilePath: '.github/workflows/release-publication.yml',
  calledWorkflowRef: 'a3-suite/a3-rust-cruiser/.github/workflows/release-publication.yml@refs/heads/main',
  calledWorkflowSha: SHA,
});

describe('verifyWorkflowIdentity(WorkflowIdentityInput)', () => {
  // target_id: verifyWorkflowIdentity(WorkflowIdentityInput)
  test('returns the verified snapshot sha for a default-branch reusable call', () => {
    // Arrange
    const input = base();
    // Act
    const result = verifyWorkflowIdentity(input);
    // Assert
    expect(result).toStrictEqual({ sha: SHA });
  });

  // target_id: verifyWorkflowIdentity(WorkflowIdentityInput)
  test('rejects a caller ref that is not the default-branch snapshot', () => {
    // Arrange
    const input = { ...base(), callerWorkflowRef: base().callerWorkflowRef.replace('refs/heads/main', 'refs/heads/feature') };
    // Act + Assert
    expect(() => verifyWorkflowIdentity(input)).toThrow(/ci-workflow-identity-caller-ref-mismatch/);
  });

  // target_id: verifyWorkflowIdentity(WorkflowIdentityInput)
  test('rejects a called workflow from another repository, path, or ref', () => {
    // Arrange
    const cases = [
      { ...base(), calledWorkflowRepository: 'other/repo' },
      { ...base(), calledWorkflowFilePath: '.github/workflows/other.yml' },
      { ...base(), calledWorkflowRef: base().calledWorkflowRef.replace('refs/heads/main', 'refs/heads/feature') },
    ];
    // Act
    const errors = cases.map((input) => {
      try {
        verifyWorkflowIdentity(input);
      } catch (error) {
        return String(error);
      }
      return '';
    });
    // Assert
    expect(errors.map((error) => error.match(/ci-workflow-identity-[a-z-]+/)?.[0])).toStrictEqual([
      'ci-workflow-identity-called-repository-mismatch',
      'ci-workflow-identity-called-path-mismatch',
      'ci-workflow-identity-called-ref-mismatch',
    ]);
  });

  // target_id: verifyWorkflowIdentity(WorkflowIdentityInput)
  test('rejects missing, non-hex, or divergent snapshot shas', () => {
    // Arrange
    const cases = [
      { ...base(), callerWorkflowSha: '' },
      { ...base(), calledWorkflowSha: SHA.toUpperCase() },
      { ...base(), calledWorkflowSha: OTHER_SHA },
    ];
    // Act
    const errors = cases.map((input) => {
      try {
        verifyWorkflowIdentity(input);
      } catch (error) {
        return String(error);
      }
      return '';
    });
    // Assert
    expect(errors.map((error) => error.match(/ci-workflow-identity-[a-z-]+/)?.[0])).toStrictEqual([
      'ci-workflow-identity-sha-invalid',
      'ci-workflow-identity-sha-invalid',
      'ci-workflow-identity-sha-mismatch',
    ]);
  });
});
