import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The exhaustive all-pairs sweep and the 500k-node perf smoke are the two
    // slow cases; everything else is milliseconds.
    testTimeout: 120_000,
  },
});
