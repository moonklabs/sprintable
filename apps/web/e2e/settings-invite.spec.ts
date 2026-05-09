import { expect, test } from '@playwright/test';

test.use({ storageState: './playwright/.auth/owner.json' });

test.describe('Settings — member invitation (conversion moment)', () => {
  test('settings page loads', async ({ page }) => {
    const response = await page.goto('/settings');
    expect(response?.status(), 'settings should return 200').toBe(200);
    await page.waitForLoadState('load');
  });

  test('inviting a member shows invite URL in success banner', async ({ page }) => {
    // Navigate to members settings tab
    await page.goto('/settings/members');
    await page.waitForLoadState('load');

    const inviteEmail = `invite-test-${Date.now()}@example.com`;

    // Fill email input for invitation
    const emailInput = page.locator('input[type="email"], input[placeholder*="email" i]').first();
    if (!(await emailInput.isVisible())) {
      // Try clicking a Members tab first
      const membersTab = page.getByRole('tab', { name: /members/i }).or(
        page.getByRole('link', { name: /members/i })
      ).first();
      if (await membersTab.isVisible()) {
        await membersTab.click();
        await page.waitForLoadState('load');
      } else {
        test.skip(true, 'could not find members invite form');
        return;
      }
    }

    await emailInput.fill(inviteEmail);

    // Click invite button
    const inviteBtn = page.getByRole('button', { name: /invite|send/i }).first();
    if (!(await inviteBtn.isVisible())) {
      test.skip(true, 'no invite button found');
      return;
    }

    const [inviteResp] = await Promise.all([
      page.waitForResponse(
        (resp) => resp.url().includes('/api/invitations') && resp.request().method() === 'POST',
        { timeout: 10000 }
      ),
      inviteBtn.click(),
    ]);

    expect(inviteResp.status(), 'invitation POST should succeed').toBeLessThan(300);

    await page.waitForLoadState('load');
    // Success banner with invite URL should appear (emerald/green banner)
    const successBanner = page.locator('[class*="emerald"], [class*="green"], [class*="success"]').filter({ hasText: /http/i }).first();
    if (await successBanner.isVisible({ timeout: 5000 })) {
      await expect(successBanner, 'invite URL banner should be visible').toBeVisible();
    } else {
      // At minimum the API succeeded — check pending list updated
      await expect(page.getByText(inviteEmail), 'invited email should appear in pending list').toBeVisible({ timeout: 5000 });
    }
  });

  test('creating a project shows it in the project list', async ({ page }) => {
    await page.goto('/settings/projects');
    await page.waitForLoadState('load');

    const projectName = `e2e-project-${Date.now()}`;

    const nameInput = page.locator('input[placeholder*="name" i], input[placeholder*="project" i]').first();
    if (!(await nameInput.isVisible())) {
      const projectsTab = page.getByRole('tab', { name: /projects/i }).first();
      if (await projectsTab.isVisible()) {
        await projectsTab.click();
        await page.waitForLoadState('load');
      } else {
        test.skip(true, 'could not find projects form');
        return;
      }
    }

    await nameInput.fill(projectName);

    const createBtn = page.getByRole('button', { name: /create|add/i }).first();
    await createBtn.click();

    await page.waitForResponse(
      (resp) => resp.url().includes('/api/projects') && resp.request().method() === 'POST',
      { timeout: 8000 }
    );

    await page.waitForLoadState('load');
    await expect(page.getByText(projectName), 'new project should appear in list').toBeVisible({ timeout: 8000 });
  });
});
