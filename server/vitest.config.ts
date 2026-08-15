import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./src/tests/setup.ts'],
    environment: 'node',
    globals: true,
    testTimeout: 10000,
    fileParallelism: false,
    include: ['src/tests/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
  },
});