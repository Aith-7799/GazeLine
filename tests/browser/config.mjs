import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.', testMatch: '*.spec.mjs', timeout: 60_000,
  workers: 1, reporter: 'list', outputDir: '../../node_modules/.cache/calibration-results',
  use: { channel: process.env.GAZELINE_TEST_BROWSER || undefined },
});
