import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    globals: false,
    include: ['actions/*/tests/**/*.test.{ts,mjs}', 'runtime/*/tests/**/*.test.{ts,mjs}', 'tests/*.test.mjs'],
    pool: 'forks',
    // Passing tests keep expected diagnostics out of the log; failing tests still print theirs.
    silent: 'passed-only',
    reporters: ['default', 'hanging-process'],
    // Measured on 10 cores: 4 -> 91s, 6 -> 67s, 8 -> 63s. Use up to 6 workers, never fewer than the former fixed 4.
    maxWorkers: Math.max(4, Math.min(6, availableParallelism())),
    maxConcurrency: 4,
    testTimeout: 60000,
    hookTimeout: 60000,
    coverage: {
      enabled: false,
      include: ['actions/*/src/**/*.ts', 'runtime/**/*.ts', 'runtime/**/*.mts', 'runtime/**/*.mjs'],
      exclude: ['**/tests/**', '**/*.test.*', '**/dist/**', '**/*.d.ts', '**/*.d.mts', '**/*.types.ts', '**/*.constants.ts', 'runtime/diagnostics/failure.mjs'],
    },
  },
});
