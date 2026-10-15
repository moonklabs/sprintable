import { defineConfig, devices } from '@playwright/test';

// story #4557: layout specs that build their page from the component's own classes and the real Tailwind build — no server,
// no sign-in (the main config's global setup logs into a running app). `pnpm e2e:layout`.
export default defineConfig({
  testDir: './e2e',
  testMatch: /\.layout\.spec\.ts$/,
  forbidOnly: !!process.env['CI'],
  reporter: 'line',
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
