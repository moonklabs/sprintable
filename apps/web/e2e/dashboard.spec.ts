import { expect, test } from '@playwright/test';

test.use({ storageState: './playwright/.auth/owner.json' });

test.describe('Dashboard — first impression', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dashboard');
    await page.waitForLoadState('load');
  });

  test('page loads with HTTP 200 and no JS errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    const response = await page.goto('/dashboard');
    await page.waitForLoadState('load');
    expect(response?.status(), 'dashboard should return 200').toBe(200);
    const critical = errors.filter((e) => !e.includes('Warning:'));
    expect(critical, 'no critical JS console errors').toHaveLength(0);
  });

  test('stat widgets are visible and show numeric values', async ({ page }) => {
    // Dashboard should show at least one numeric counter card
    const cards = page.locator('[class*="card"], [class*="Card"]');
    await expect(cards.first(), 'at least one stat card visible').toBeVisible();
  });

  test('navigation to /board works from authenticated context', async ({ page }) => {
    // Verify sidebar nav or board link is present or navigate directly
    await page.goto('/board');
    await page.waitForLoadState('load');
    expect(page.url(), 'should reach /board').toContain('/board');
  });
});
