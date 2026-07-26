/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  test: {
    // The pure-logic tests run in Node; the map components are verified in the
    // browser (npm run dev), not here -- MapLibre needs a real WebGL canvas.
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
