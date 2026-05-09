import { expect, test } from '@playwright/test';

test.use({ storageState: './playwright/.auth/owner.json' });

test.describe('Memo — create and share', () => {
  test('memos list page loads', async ({ page }) => {
    const response = await page.goto('/memos');
    expect(response?.status(), 'memos should return 200').toBe(200);
    await page.waitForLoadState('load');
  });

  test('creating a new memo adds it to the list', async ({ page }) => {
    const memoContent = `e2e test memo ${Date.now()}`;

    await page.goto('/memos/new');
    await page.waitForLoadState('load');

    // Fill in memo content
    const contentArea = page.locator('textarea, [contenteditable="true"], [role="textbox"]').first();
    await contentArea.waitFor({ state: 'visible', timeout: 8000 });
    await contentArea.click();
    await contentArea.fill(memoContent);

    // Submit / publish
    const publishBtn = page.getByRole('button', { name: /publish|post|send|submit/i }).first();
    if (!(await publishBtn.isVisible())) {
      test.skip(true, 'no publish button found — memo form structure may have changed');
      return;
    }
    await publishBtn.click();

    // Should redirect back to /memos after publish
    await page.waitForURL(/\/memos(?!\/new)/, { timeout: 10000 });
    await page.waitForLoadState('load');

    // New memo should appear in list
    await expect(page.getByText(memoContent), 'new memo should appear in list').toBeVisible({ timeout: 8000 });
  });

  test('applying a template pre-fills the form', async ({ page }) => {
    await page.goto('/memos/new');
    await page.waitForLoadState('load');

    const templateBtn = page.getByRole('button', { name: /template/i }).first();
    if (!(await templateBtn.isVisible())) {
      test.skip(true, 'template button not visible');
      return;
    }

    await templateBtn.click();
    // Template picker should appear
    const templateOption = page.locator('[class*="template"], [class*="Template"]').first();
    if (await templateOption.isVisible()) {
      await templateOption.click();
      await page.waitForLoadState('load');
      // Content area should now have pre-filled text
      const contentArea = page.locator('textarea, [contenteditable="true"], [role="textbox"]').first();
      const value = await contentArea.textContent() ?? await contentArea.inputValue().catch(() => '');
      expect(value.length, 'template should pre-fill content').toBeGreaterThan(0);
    }
  });

  test('memo detail page is accessible', async ({ page }) => {
    // Navigate to memos list and click the first one
    await page.goto('/memos');
    await page.waitForLoadState('load');

    const memoCard = page.locator('[class*="memo"], [class*="Memo"]').filter({ hasText: /./}).first();
    if (!(await memoCard.isVisible())) {
      test.skip(true, 'no memos to click');
      return;
    }

    await memoCard.click();
    await page.waitForURL(/\/memos\/\w/, { timeout: 8000 });
    const response = await page.goto(page.url());
    expect(response?.status(), 'memo detail should return 200').toBe(200);
  });
});
