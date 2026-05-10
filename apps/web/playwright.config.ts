import { defineConfig, devices } from '@playwright/test';
import { config as dotenvConfig } from 'dotenv';
import { existsSync } from 'fs';
import { resolve } from 'path';

// Load .env.playwright if it exists (local overrides, gitignored)
const localEnvFile = resolve(__dirname, '.env.playwright');
if (existsSync(localEnvFile)) dotenvConfig({ path: localEnvFile });

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
        command: 'pnpm dev',
        url: 'http://localhost:3108',
        reuseExistingServer: !process.env['CI'],
      },
});
