import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // Every test resets the one shared server (/api/dev/reset), so they must not overlap.
  workers: 1,
  use: { baseURL: 'http://localhost:5173' },
  webServer: {
    // Dev tools (/api/dev, the Chaos panel) are what the recovery-state tests drive.
    command: 'pnpm exec cross-env DEV_TOOLS=1 pnpm dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
