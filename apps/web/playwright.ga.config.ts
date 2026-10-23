import { defineConfig, devices } from '@playwright/test';

// story 4719: the real-browser measurement of what Google Analytics is sent (`e2e/ga-collect.4719.spec.ts`). No sign-in (the pages it
// uses are public), no backend; the app is started here with a placeholder measurement id so the real gtag.js loads (that script is a plain GET to
// googletagmanager.com carrying only the placeholder id) and every BEACON to Google Analytics is intercepted (no page data leaves the machine). One worker. Not part of CI: `pnpm e2e:ga` (the spec skips itself without GA_E2E_ID).
// The port is a rare one on purpose — `pnpm dev` clears whatever listens on its port, which is not for a shared machine.
const PORT = process.env['GA_E2E_PORT'] ?? '3419';
const GA_ID = 'G-QA4719TEST';
process.env['GA_E2E_ID'] = GA_ID; // the spec skips itself without it (so the default `playwright test` never runs it)

export default defineConfig({
  testDir: './e2e',
  testMatch: /ga-collect\.4719\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  reporter: 'line',
  timeout: 90_000,
  use: { baseURL: `http://localhost:${PORT}` },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npx next dev --webpack --port ${PORT}`,
    url: `http://localhost:${PORT}/forgot-password`,
    reuseExistingServer: false,
    timeout: 240_000,
    env: { NEXT_PUBLIC_GA4_MEASUREMENT_ID: GA_ID },
  },
  metadata: { gaId: GA_ID },
});
