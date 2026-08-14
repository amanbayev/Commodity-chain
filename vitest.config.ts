import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@commodity-chain/ledger': fileURLToPath(
        new URL('./packages/ledger/src/index.ts', import.meta.url),
      ),
      '@commodity-chain/matching-core': fileURLToPath(
        new URL('./packages/matching-core/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    fileParallelism: false,
    include: ['apps/**/*.{spec,test}.{ts,tsx}', 'packages/**/*.{spec,test}.ts'],
  },
});
