import { expect, test } from '@playwright/test';

/**
 * Verifies the board page loads in OSS mode with sample data.
 * Requires the dev server to be running with OSS_MODE=true.
 */
test.describe('OSS board page', () => {
  test.beforeEach(async ({ request }) => {
    // Ensure sample data is seeded before each test
    await request.post('/api/oss/seed');
  });

  test('board page loads without error', async ({ page }) => {
    const response = await page.goto('/board');
    expect(response?.status()).toBeLessThan(400);
  });

  test('board page renders kanban columns', async ({ page }) => {
    await page.goto('/board');
    // Kanban board should have at least one column visible
    // (todo, in_progress, or done)
    await expect(page.locator('[data-testid="kanban-column"], [class*="kanban"]').first()).toBeVisible({ timeout: 10000 });
  });

  test('health endpoint returns ok', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('status');
  });
});
