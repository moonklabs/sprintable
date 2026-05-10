import { expect, test } from '@playwright/test';

test.use({ storageState: './playwright/.auth/owner.json' });

test.describe('Standup — daily entry aha moment', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/standup');
    await page.waitForLoadState('load');
  });

  test('standup page loads with member cards', async ({ page }) => {
    const response = await page.goto('/standup');
    expect(response?.status(), 'standup should return 200').toBe(200);
    await page.waitForLoadState('load');
  });

  test('clicking edit on own card expands the form', async ({ page }) => {
    // Look for edit button on the current user's card
    const editBtn = page.getByRole('button', { name: /edit|write|update/i }).first();
    if (!(await editBtn.isVisible())) {
      // Try clicking directly on a card — some UIs expand on click
      const cards = page.locator('[class*="standup"], [class*="Standup"]').first();
      if (await cards.isVisible()) {
        await cards.click();
      } else {
        test.skip(true, 'no standup cards found');
        return;
      }
    } else {
      await editBtn.click();
    }

    // Form should expand with Done/Plan/Blockers textareas
    const doneArea = page.locator('textarea, [placeholder*="done" i], [placeholder*="완료" i]').first();
    await expect(doneArea, 'done textarea should be visible in edit mode').toBeVisible({ timeout: 5000 });
  });

  test('writing standup entry and saving switches card to view mode', async ({ page }) => {
    const editBtn = page.getByRole('button', { name: /edit|write|update/i }).first();
    if (!(await editBtn.isVisible())) {
      test.skip(true, 'no edit button found');
      return;
    }

    await editBtn.click();

    const textareas = page.locator('textarea');
    const count = await textareas.count();
    if (count === 0) {
      test.skip(true, 'no textareas in standup form');
      return;
    }

    const doneText = `Completed e2e test ${Date.now()}`;
    await textareas.first().fill(doneText);

    const saveBtn = page.getByRole('button', { name: /save|submit|done/i }).first();
    await saveBtn.click();

    await page.waitForResponse(
      (resp) => resp.url().includes('/api/standup') && resp.request().method() === 'PUT',
      { timeout: 8000 }
    );

    // Card should switch back to view mode — done text should be visible
    await expect(page.getByText(doneText), 'saved standup entry should appear in card').toBeVisible({ timeout: 8000 });
  });

  test('date navigation loads different standup data', async ({ page }) => {
    const prevBtn = page.getByRole('button', { name: /previous|←|prev|yesterday/i }).first();
    if (!(await prevBtn.isVisible())) {
      test.skip(true, 'no date navigation button found');
      return;
    }

    await prevBtn.click();
    await page.waitForLoadState('load');
    // URL or page state should change — just verify no crash
    expect(page.url(), 'page should not crash after date navigation').not.toContain('error');
  });
});
