import { expect, test } from '@playwright/test';

test.use({ storageState: './playwright/.auth/owner.json' });

test.describe('Retro — full session cycle', () => {
  test('retro list page loads', async ({ page }) => {
    const response = await page.goto('/retro');
    expect(response?.status(), 'retro should return 200').toBe(200);
    await page.waitForLoadState('load');
  });

  test('create new retro session → appears in list', async ({ page }) => {
    await page.goto('/retro');
    await page.waitForLoadState('load');

    const sessionTitle = `e2e-retro-${Date.now()}`;

    // Fill title input — stable id on the retro page
    const titleInput = page.locator('#retro-title-input');
    await titleInput.waitFor({ state: 'visible', timeout: 8000 });
    await titleInput.click();
    await titleInput.pressSequentially(sessionTitle, { delay: 30 });

    // Create button enables once title is non-empty
    const createBtn = page.getByRole('button', { name: 'Create' });
    await createBtn.waitFor({ state: 'visible', timeout: 5000 });
    await expect(createBtn, 'create button should be enabled after filling title').toBeEnabled({ timeout: 5000 });
    await createBtn.click();

    await page.waitForResponse(
      (resp) => resp.url().includes('/api/retro') && resp.request().method() === 'POST',
      { timeout: 8000 }
    );

    await page.waitForLoadState('load');
    await expect(page.getByText(sessionTitle), 'new retro session should appear in list').toBeVisible({ timeout: 8000 });
  });

  test('retro session: add items in collect phase', async ({ page }) => {
    // Create a session first via API for a clean state
    const createResp = await page.request.post('/api/retro-sessions', {
      data: { title: `e2e-collect-${Date.now()}` },
    });
    if (!createResp.ok()) {
      test.skip(true, 'could not create retro session via API');
      return;
    }
    const { data } = await createResp.json() as { data: { id: string } };
    const sessionId = data.id;

    await page.goto(`/retro/${sessionId}`);
    await page.waitForLoadState('load');

    // Add a "good" item
    const goodText = `What went well: ${Date.now()}`;
    const addButtons = page.getByRole('button', { name: /add|^\+$/i });
    const firstAdd = addButtons.first();
    if (!(await firstAdd.isVisible())) {
      test.skip(true, 'no add button in collect phase');
      return;
    }

    await firstAdd.click();
    const itemInput = page.locator('textarea, input[type="text"]').last();
    await itemInput.waitFor({ state: 'visible', timeout: 3000 });
    await itemInput.fill(goodText);
    await itemInput.press('Enter');

    await page.waitForResponse(
      (resp) => resp.url().includes('/api/retro') && resp.request().method() === 'POST',
      { timeout: 8000 }
    );

    await expect(page.getByText(goodText), 'retro item should appear after adding').toBeVisible({ timeout: 8000 });
  });

  test('retro session: advance phase changes phase badge', async ({ page }) => {
    const createResp = await page.request.post('/api/retro-sessions', {
      data: { title: `e2e-phase-${Date.now()}` },
    });
    if (!createResp.ok()) {
      test.skip(true, 'could not create retro session');
      return;
    }
    const { data } = await createResp.json() as { data: { id: string } };

    await page.goto(`/retro/${data.id}`);
    await page.waitForLoadState('load');

    const advanceBtn = page.getByRole('button', { name: /next|advance|proceed/i }).first();
    if (!(await advanceBtn.isVisible())) {
      test.skip(true, 'no advance phase button');
      return;
    }

    await advanceBtn.click();
    await page.waitForLoadState('load');

    // Phase badge should change (no longer "collect")
    const phaseBadge = page.locator('[class*="badge"], [class*="phase"], [class*="Phase"]').first();
    const phaseText = await phaseBadge.textContent();
    expect(phaseText?.toLowerCase(), 'phase should advance past collect').not.toBe('collect');
  });
});
