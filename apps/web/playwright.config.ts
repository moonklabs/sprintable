import { defineConfig, devices } from '@playwright/test';
import { config as dotenvConfig } from 'dotenv';
import { existsSync } from 'fs';
import { resolve } from 'path';

// Load .env.playwright if it exists (local overrides, gitignored)
const localEnvFile = resolve(__dirname, '.env.playwright');
if (existsSync(localEnvFile)) dotenvConfig({ path: localEnvFile });

// story #4927 AC1 — the web server runs through e2e/support/dev-server-logged.mjs, which stamps each output line and keeps a copy in this file;
// the contrast guard reads the window of a failing test from it. The env var is set here so the runner, the server and the workers share one path.
const devServerLog = process.env['E2E_WEBSERVER_LOG'] ?? resolve(__dirname, 'playwright/server-logs/next-dev.log');
process.env['E2E_WEBSERVER_LOG'] = devServerLog;

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
        command: 'node e2e/support/dev-server-logged.mjs',
        url: 'http://localhost:3108',
        reuseExistingServer: !process.env['CI'],
        // default 'ignore' dropped Next's own lines (compile times) from the CI log — only stderr reached it, with no time
        stdout: 'pipe',
        stderr: 'pipe',
      },
});
