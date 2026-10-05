import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

describe('provider installer', () => {
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
