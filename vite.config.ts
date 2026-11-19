/// <reference types="vitest" />
import { defineConfig } from 'vite';
import { interviewApiPlugin } from './server/interviews.mjs';

export default defineConfig({
  plugins: process.env.VITEST ? [] : [interviewApiPlugin()],
  server: {
    port: 5173, strictPort: false,
    fs: { deny: ['**/.*', '**/.*/**', '**/*.{crt,pem,sqlite,sqlite-wal,sqlite-shm}'] },
  },
  build: { target: 'es2020' },
  // vitest picks the `test` key up via the triple-slash reference above
  // (cast keeps vite's own types happy - `test` is vitest's field)
  ...({ test: { environment: 'node', include: ['tests/**/*.test.ts'] } }),
} as any);

