import { chromium } from '@playwright/test';
import fs from 'fs';
import path from 'path';

async function globalSetup() {
  const baseURL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:3108';
  const authDir = path.join(__dirname, '../playwright/.auth');
  fs.mkdirSync(authDir, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL });

  // Call login API directly — cookies are set in the browser context
  const resp = await context.request.post('/api/auth/login', {
    data: { email: 'owner@sprintable.dev', password: 'password123' },
    headers: {
      'Content-Type': 'application/json',
      Origin: baseURL,
    },
  });

  if (!resp.ok()) {
    const body = await resp.text();
    throw new Error(`Login failed (${resp.status()}): ${body}`);
  }

  // Navigate to /inbox once to confirm the session works server-side
  const page = await context.newPage();
  await page.goto('/inbox');
  await page.waitForURL(/\/inbox/, { timeout: 15000 });

  await context.storageState({ path: path.join(authDir, 'owner.json') });
  await browser.close();
}

export default globalSetup;
