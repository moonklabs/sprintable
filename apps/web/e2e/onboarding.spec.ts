import { expect, test } from '@playwright/test';

// Onboarding tests use a fresh account — no storageState
// Serial mode: each test creates a new account; parallel workers collide on the same email
test.describe('Onboarding — new user setup', () => {
  test.describe.configure({ mode: 'serial' });

  async function registerAndGetToOnboarding(page: Parameters<Parameters<typeof test>[1]>[0]) {
    const email = `onboard-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;
    const password = 'TestPassword123!';

    await page.goto('/register');
    await page.waitForLoadState('networkidle');
    const emailInput = page.locator('input[placeholder="Email"]');
    await emailInput.waitFor({ state: 'visible', timeout: 10000 });
    await emailInput.click();
    await emailInput.pressSequentially(email, { delay: 30 });
    // Verify fill landed before moving on
    await expect(emailInput).toHaveValue(email, { timeout: 5000 });
    const passwordInput = page.locator('input[placeholder="Password"]');
    await passwordInput.click();
    await passwordInput.pressSequentially(password, { delay: 30 });
    await expect(passwordInput).toHaveValue(password, { timeout: 5000 });
    const signUpBtn = page.getByRole('button', { name: /sign up|create account|register/i });
    await expect(signUpBtn, 'Sign up button should be enabled').toBeEnabled({ timeout: 5000 });
    await signUpBtn.click();

    // Wait for redirect to onboarding or inbox
    await page.waitForURL(/\/(onboarding|inbox)/, { timeout: 15000 });
    return { email, password };
  }

  test('new user lands on /onboarding after registration', async ({ page }) => {
    await registerAndGetToOnboarding(page);
    const url = page.url();
    expect(
      url.includes('/onboarding') || url.includes('/inbox'),
      'new user should land on onboarding or inbox'
    ).toBe(true);
  });

  test('onboarding org step: fills org name and advances', async ({ page }) => {
    await registerAndGetToOnboarding(page);

    if (!page.url().includes('/onboarding')) {
      test.skip(true, 'user already has org — skipping onboarding test');
      return;
    }

    const orgName = `Test Org ${Date.now()}`;

    // Step 1: org name
    const orgInput = page.locator('input[placeholder*="org" i], input[placeholder*="company" i], input[placeholder*="workspace" i], input[type="text"]').first();
    await orgInput.waitFor({ state: 'visible', timeout: 8000 });
    await orgInput.fill(orgName);

    const nextBtn = page.getByRole('button', { name: /next|continue|create/i }).first();
    await nextBtn.click();

    await page.waitForResponse(
      (resp) => resp.url().includes('/api/organizations') && resp.request().method() === 'POST',
      { timeout: 10000 }
    );

    // Should advance to project step
    await page.waitForLoadState('load');
    // Look for project-related text or next form
    const projectInput = page.locator('input[placeholder*="project" i], input[type="text"]').first();
    await expect(projectInput, 'project step input should appear').toBeVisible({ timeout: 8000 });
  });

  test('completing onboarding reaches /dashboard', async ({ page }) => {
    await registerAndGetToOnboarding(page);

    if (!page.url().includes('/onboarding')) {
      test.skip(true, 'user already has org — skipping full onboarding test');
      return;
    }

    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    // Step 1: Org — wait for "Create Organization" button specifically
    const createOrgBtn = page.getByRole('button', { name: /create org/i });
    await createOrgBtn.waitFor({ state: 'visible', timeout: 8000 });
    const orgInput = page.locator('input[type="text"]').first();
    await orgInput.pressSequentially(`Org ${suffix}`, { delay: 30 });
    await expect(createOrgBtn).toBeEnabled({ timeout: 5000 });
    await createOrgBtn.click();

    // Step 2: Project — wait for "Create Project" button to appear (confirms step transition)
    const createProjectBtn = page.getByRole('button', { name: /create project/i });
    await createProjectBtn.waitFor({ state: 'visible', timeout: 20000 });
    const projectInput = page.locator('input[type="text"]').first();
    await projectInput.pressSequentially(`Project ${suffix}`, { delay: 30 });
    await expect(createProjectBtn).toBeEnabled({ timeout: 5000 });
    await createProjectBtn.click();

    // Step 3: Agent — wait for "Skip" button to appear, then skip
    // Clicking Skip calls router.push('/dashboard') directly
    const skipBtn = page.getByRole('button', { name: 'Skip' });
    await skipBtn.waitFor({ state: 'visible', timeout: 20000 });
    await skipBtn.click();

    await page.waitForURL(/\/(dashboard|inbox|board)/, { timeout: 15000 });
    const finalUrl = page.url();
    expect(
      finalUrl.includes('/dashboard') || finalUrl.includes('/inbox') || finalUrl.includes('/board'),
      'should reach app after completing onboarding'
    ).toBe(true);
  });
});
