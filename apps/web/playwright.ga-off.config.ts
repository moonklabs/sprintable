import { defineConfig, devices } from '@playwright/test';

// story 4822: the real-browser measurement that DISABLE_ANALYTICS=true sends nothing to Google (`e2e/ga-off.4822.spec.ts`). The app runs with a placeholder measurement id baked in,
// once with the switch on (`GA_MODE=off`) and once without it (`GA_MODE=on`, the control — it proves the harness would see the tag). Run one after the other (`pnpm e2e:ga-off`): `next dev` refuses a second server in one folder. Nothing
// leaves the machine: every request to a Google host is answered here. No sign-in, no backend (the pages it uses are public). One worker. Not part of CI: `pnpm e2e:ga-off`.
// The ports are rare on purpose — `pnpm dev` clears whatever listens on its port, which is not for a shared machine.
const MODE = process.env['GA_MODE'] === 'on' ? 'on' : 'off'; // 'off' = the switch is ON (DISABLE_ANALYTICS=true); 'on' = the switch is unset (the control)
const PORT = process.env['GA_PORT'] ?? (MODE === 'off' ? '3421' : '3422');
const GA_ID = 'G-QA4822TEST';
process.env['GA_OFF_E2E'] = '1';
process.env['GA_MODE'] = MODE;
process.env['GA_PORT'] = PORT;

export default defineConfig({
  testDir: './e2e',
  testMatch: /ga-off\.4822\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  reporter: 'line',
  timeout: 120_000,
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npx next dev --webpack --port ${PORT}`,
    url: `http://localhost:${PORT}/forgot-password`,
    reuseExistingServer: false,
    timeout: 240_000,
    env: MODE === 'off' ? { NEXT_PUBLIC_GA4_MEASUREMENT_ID: GA_ID, DISABLE_ANALYTICS: 'true' } : { NEXT_PUBLIC_GA4_MEASUREMENT_ID: GA_ID },
  },
  metadata: { gaId: GA_ID },
});
