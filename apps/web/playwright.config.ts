import { defineConfig, devices } from '@playwright/test';
import { config as dotenvConfig } from 'dotenv';
import { existsSync } from 'fs';
import { resolve } from 'path';

// Load .env.playwright if it exists (local overrides, gitignored)
const localEnvFile = resolve(__dirname, '.env.playwright');
if (existsSync(localEnvFile)) dotenvConfig({ path: localEnvFile });

// story #4927 AC1 — OPT-IN server log. With E2E_SERVER_LOG=1 the web server runs through e2e/support/dev-server-logged.mjs, which stamps each output line
// and keeps a copy of the allowed fields in this file; the contrast guard reads the window of a failing test from it.
// DEFAULT OFF (also in CI): measured on the same base (8074c746c) the wrapper + piped stdout/stderr made the Contrast guard flaky — wrapper only: 1 failed ·
// 12 flaky · 8.9 min (red); watch only: 3 flaky · 5.2 min; neither: 2 flaky · 4.9 min. So with the switch off the webServer is byte-for-byte develop's
// (`pnpm dev`, no stdout/stderr keys). Turn it on knowingly (e.g. the 3-way compile repro) and mark the numbers «server log on».
const serverLogOn = process.env['E2E_SERVER_LOG'] === '1';
if (serverLogOn) {
  // one path shared by the runner, the server and the workers
  process.env['E2E_WEBSERVER_LOG'] = process.env['E2E_WEBSERVER_LOG'] ?? resolve(__dirname, 'playwright/server-logs/next-dev.log');
}

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  workers: process.env['CI'] ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:3108',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: process.env['PLAYWRIGHT_BASE_URL']
    ? undefined
    : {
        command: serverLogOn ? 'node e2e/support/dev-server-logged.mjs' : 'pnpm dev',
        url: 'http://localhost:3108',
        reuseExistingServer: !process.env['CI'],
        // default 'ignore' drops Next's own lines (compile times) from the CI log — piped only when the server log is on
        ...(serverLogOn ? { stdout: 'pipe' as const, stderr: 'pipe' as const } : {}),
      },
});
