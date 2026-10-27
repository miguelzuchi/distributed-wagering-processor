import { defineConfig } from 'vitest/config';

process.env.NODE_ENV = 'test';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    fileParallelism: false,
  },
});
