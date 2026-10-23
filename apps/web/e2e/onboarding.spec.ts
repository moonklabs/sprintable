import { expect, test } from '@playwright/test';

// Onboarding tests use a fresh account — no storageState
// Serial mode: each test creates a new account; parallel workers collide on the same email
test.describe('Onboarding — new user setup', () => {
  test.describe.configure({ mode: 'serial' });

  async function registerAndGetToOnboarding(page: Parameters<Parameters<typeof test>[1]>[0]) {
    const email = `onboard-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;
    const password = 'TestPassword123!';

    await page.goto('/register');
    // story 4669: with Google on, the e-mail form is folded under [Sign up with e-mail] — open it first (a build with no OAuth
    // shows the form as before and has no such button)
    const emailOpen = page.getByTestId('register-email-open');
    if (await emailOpen.isVisible({ timeout: 3000 }).catch(() => false)) await emailOpen.click();
    // CHANGES(페드루 PO, 2026-09-18) — networkidle 정리 — 바로 다음 줄의 이메일 입력창
    // visible 대기가 이미 decisive 신호라 networkidle은 여기서도 그냥 중복.
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

  test('onboarding arrival: the organization is made without a name field, then the web way reaches the project step', async ({ page }) => {
    // story 4715: no organization-name step — arrival reads the pending invites (none for a fresh account) and makes the organization
    const orgMade = page.waitForResponse(
      (resp) => resp.url().includes('/api/organizations') && resp.request().method() === 'POST',
      { timeout: 20000 }
    );
    await registerAndGetToOnboarding(page);

    if (!page.url().includes('/onboarding')) {
      test.skip(true, 'user already has org — skipping onboarding test');
      return;
    }

    await orgMade;
    await expect(page.locator('input[type="text"]'), 'no organization-name field').toHaveCount(0);

    // the one first screen → «이미 돌고 있는 에이전트 연결하기» — the web way keeps the project step
    const connect = page.getByTestId('onboarding-first-connect');
    await connect.waitFor({ state: 'visible', timeout: 20000 });
    await connect.click();
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

    // Step 1 (story 4715): the organization is made on arrival — the first screen's web way leads to the project step
    const connect = page.getByTestId('onboarding-first-connect');
    await connect.waitFor({ state: 'visible', timeout: 20000 });
    await connect.click();

    // Step 2: Project — wait for "Create Project" button to appear (confirms step transition)
    const createProjectBtn = page.getByRole('button', { name: /create project/i });
    await createProjectBtn.waitFor({ state: 'visible', timeout: 20000 });
    const projectInput = page.locator('input[type="text"]').first();
    await projectInput.pressSequentially(`Project ${suffix}`, { delay: 30 });
    await expect(createProjectBtn).toBeEnabled({ timeout: 5000 });
    await createProjectBtn.click();

    // Step 3: Agent — wait for "Skip" button to appear, then skip
    // story 4668: Skip goes to the connect step (the desktop card is there — no dead end), not home
    const skipBtn = page.getByRole('button', { name: 'Skip' });
    await skipBtn.waitFor({ state: 'visible', timeout: 20000 });
    await skipBtn.click();

    // Step 4: Connect without an agent — the desktop section's own button is the way out (4668: no footer here)
    const connectNoAgent = page.getByTestId('connect-step-no-agent');
    await connectNoAgent.waitFor({ state: 'visible', timeout: 20000 });
    await page.getByTestId('connect-step-desktop-finish').click();

    await page.waitForURL(/\/(dashboard|inbox|board|today|chats)/, { timeout: 15000 });
    const finalUrl = page.url();
    expect(
      finalUrl.includes('/dashboard') || finalUrl.includes('/inbox') || finalUrl.includes('/board'),
      'should reach app after completing onboarding'
    ).toBe(true);
  });
});
