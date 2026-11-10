import { defineConfig } from '@playwright/test';
import * as dotenv from 'dotenv';
dotenv.config();

export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  // Journeys are stateful conversations; keep retries off so a protocol
  // break fails at the exact step, not on a lucky rerun.
  retries: 0,
  reporter: [['html', { open: 'never' }], ['list']],
  // No traces: each API call is attached to the test as decoded JSON
  // (request + response) by fixtures/acquire.ts, which is more readable
  // for an API-only suite than the trace viewer.
  projects: [
    {
      name: 'naap-dev',
      use: {
        baseURL: process.env.NAAP_DEV_BASE_URL,
        extraHTTPHeaders: { 'content-type': 'application/json' },
      },
    },
    {
      name: 'harness',
      use: {
        baseURL: process.env.HARNESS_BASE_URL,
        extraHTTPHeaders: { 'content-type': 'application/json' },
      },
    },
  ],
});
