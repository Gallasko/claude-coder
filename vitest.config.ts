import { defineConfig } from 'vitest/config';
import * as path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts', 'media/**/*.test.js'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/__tests__/**', 'src/test/**'],
    },
  },
  resolve: {
    alias: {
      vscode: path.resolve(__dirname, 'src/test/mocks/vscode.ts'),
    },
  },
});
