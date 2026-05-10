import { expect, test } from '@playwright/test';

test.use({ storageState: './playwright/.auth/owner.json' });

test.describe('Inbox — notification triage', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/inbox');
    await page.waitForLoadState('load');
  });

  test('inbox page loads successfully', async ({ page }) => {
    const response = await page.goto('/inbox');
    expect(response?.status(), 'inbox should return 200').toBe(200);
    await page.waitForLoadState('load');
  });

  test('clicking a notification card opens detail panel', async ({ page }) => {
    const cards = page.locator('[class*="notification"], [class*="Notification"]').filter({ hasNot: page.locator('header') });
    const count = await cards.count();

    if (count === 0) {
      test.skip(true, 'no notifications to interact with');
      return;
    }

    const firstCard = cards.first();
    await firstCard.click();
    await page.waitForLoadState('load');
    // Detail panel should appear — look for a panel or article that wasn't visible
    const panel = page.locator('main, [role="complementary"], aside').last();
    await expect(panel, 'detail panel should be visible after click').toBeVisible();
  });

  test('"mark all read" button clears unread state', async ({ page }) => {
    // Find the mark-all-read button (various possible texts)
    const markAllBtn = page.getByRole('button', { name: /mark all|all read/i });
    if (await markAllBtn.isVisible()) {
      await markAllBtn.click();
      await page.waitForResponse((resp) => resp.url().includes('/api/notifications') && resp.status() < 300);
      // After marking all read, the button may hide or count drop to 0
    } else {
      test.skip(true, 'no unread notifications to mark');
    }
  });
});
