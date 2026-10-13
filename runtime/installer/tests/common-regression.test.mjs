import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

describe('provider installer', () => {
  // evidence_role: supplemental
  // flow_id: provider-installer-runtime-regression
  // test_level: e2e
  describe('common regression', () => {
    test('executes provider assembly, builders and available native runtime safety regressions', () => {
      // Arrange
      const directory = fileURLToPath(new URL('.', import.meta.url));
      const python = process.platform === 'win32' ? 'python' : 'python3';
      // Act
      const result = execFileSync(python, ['-m', 'unittest', 'discover', '-s', directory, '-p', 'test_*.py'], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
      // Assert
      expect(typeof result).toBe('string');
    }, 60000);
  });
});

describe('contract.ci-release-supplemental-asset.outputs', () => {
  // evidence_role: contract
  // flow_id: standard-installer-entry-names
  // test_level: e2e
  describe('standard entry names', () => {
    test('rejects nonstandard public names before generating output', () => {
      // Arrange
      const directory = fileURLToPath(new URL('.', import.meta.url));
      const python = process.platform === 'win32' ? 'python' : 'python3';
      // Act
      const result = execFileSync(python, ['-m', 'unittest', 'discover', '-s', directory, '-p', 'test_assembly.py', '-k', 'standard_entry_names_rejected'], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8' });
      // Assert
      expect(typeof result).toBe('string');
    });
  });
});
