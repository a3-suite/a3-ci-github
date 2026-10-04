import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    globals: false,
    include: ['actions/*/tests/**/*.test.{ts,mjs}', 'runtime/*/tests/**/*.test.{ts,mjs}', 'tests/*.test.mjs'],
    pool: 'forks',
    maxWorkers: 4,
    testTimeout: 60000,
    hookTimeout: 60000,
    coverage: {
      enabled: false,
      include: ['actions/*/src/**/*.ts', 'runtime/**/*.ts', 'runtime/**/*.mjs'],
      exclude: ['**/tests/**', '**/*.test.*', '**/dist/**', '**/*.d.ts', '**/*.types.ts', '**/*.constants.ts'],
    },
  },
});
