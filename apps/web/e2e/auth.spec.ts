import { expect, test } from '@playwright/test';

const OWNER_EMAIL = 'owner@sprintable.dev';
const OWNER_PASSWORD = 'password123';
const BASE_URL = () => process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:3108';

test.describe('Authentication', () => {
  test('login API succeeds and session is recognized at /inbox', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: BASE_URL() });

    // Call login API directly — mirrors what the browser form does
    const resp = await context.request.post('/api/auth/login', {
      data: { email: OWNER_EMAIL, password: OWNER_PASSWORD },
      headers: { 'Content-Type': 'application/json', Origin: BASE_URL() },
    });
    expect(resp.status(), 'login API should return 200').toBe(200);
    const body = await resp.json() as { data?: { ok: boolean } };
    expect(body.data?.ok, 'login response data.ok should be true').toBe(true);

    // Navigate to /inbox — server-side auth guard should pass
    const page = await context.newPage();
    await page.goto('/inbox');
    await page.waitForURL(/\/inbox/, { timeout: 15000 });
    expect(page.url(), 'should land on /inbox with valid session').toContain('/inbox');

    await context.close();
  });

  test('wrong password → login API returns error', async ({ request }) => {
    const resp = await request.post('/api/auth/login', {
      data: { email: OWNER_EMAIL, password: 'wrong-password-xyz' },
      headers: { 'Content-Type': 'application/json', Origin: BASE_URL() },
    });
    expect(resp.status(), 'wrong password should return 4xx').toBeGreaterThanOrEqual(400);
    const body = await resp.json() as { error?: { message: string } };
    expect(body.error, 'should include an error object').toBeTruthy();
  });

  test('unauthenticated browser → accessing /inbox redirects to /login', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const baseURL = BASE_URL();
    await page.goto(`${baseURL}/inbox`);
    await page.waitForURL(/\/login/, { timeout: 10000 });
    expect(page.url(), 'should redirect to /login').toContain('/login');
    await context.close();
  });

  test('login page renders form elements', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator('input[placeholder="Email"]'), 'email input should be visible').toBeVisible();
    await expect(page.locator('input[placeholder="Password"]'), 'password input should be visible').toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' }), 'sign in button should be visible').toBeVisible();
  });

  test('register page renders form elements', async ({ page }) => {
    await page.goto('/register');
    await expect(page.locator('input[placeholder="Email"]'), 'email input should be visible').toBeVisible();
    await expect(page.locator('input[placeholder="Password"]'), 'password input should be visible').toBeVisible();
  });
});
