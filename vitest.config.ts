import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: process.cwd(),
  resolve: {
    alias: {
      '@warehouse/protocol': resolve(rootDir, 'packages/protocol/src/index.ts'),
      '@warehouse/armor': resolve(rootDir, 'packages/armor/src/index.ts'),
      '@warehouse/sim': resolve(rootDir, 'packages/sim/src/index.ts'),
      '@warehouse/sprites': resolve(rootDir, 'tools/sprites/src/index.ts'),
      '@warehouse/lobby': resolve(rootDir, 'apps/lobby/src/index.ts'),
      '@warehouse/site': resolve(rootDir, 'apps/site/src/index.ts'),
    },
  },
  test: {
    testTimeout: 30000,
    hookTimeout: 30000,
    maxWorkers: 2,
  },
});
