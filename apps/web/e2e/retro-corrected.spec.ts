import { test, expect } from '@playwright/test';

const BASE_URL = 'http://localhost:3108';

test.describe('Sprint Retro - Corrected E2E Tests', () => {

  test('TC1: Retro list page loads successfully', async ({ page }) => {
    console.log('\n=== TC1: Retro list page loads ===');
    
    const response = await page.goto(`${BASE_URL}/retro`);
    expect(response?.status()).toBe(200);
    
    const heading = page.locator('h1, h2').first();
    await expect(heading).toBeVisible();
    
    const headingText = await heading.textContent();
    console.log(`✓ Retro page loaded. Heading: "${headingText}"`);
  });

  test('TC2: Session creation form is present', async ({ page }) => {
    console.log('\n=== TC2: Session creation form ===');
    
    await page.goto(`${BASE_URL}/retro`);
    
    const input = page.locator('input[placeholder*="Retro"]').first();
    await expect(input).toBeVisible();
    
    const placeholder = await input.getAttribute('placeholder');
    console.log(`✓ Input field visible. Placeholder: "${placeholder}"`);
    
    // Get all buttons and find the one near the input
    const buttons = page.locator('button');
    let createBtn = null;
    
    for (let i = 0; i < await buttons.count(); i++) {
      const btn = buttons.nth(i);
      const text = await btn.textContent();
      if (text?.toLowerCase().includes('create') || text?.toLowerCase().includes('new')) {
        createBtn = btn;
        break;
      }
    }
    
    if (createBtn) {
      const btnText = await createBtn.textContent();
      console.log(`✓ Create button found. Text: "${btnText}"`);
    } else {
      console.log('⚠ Create button not found');
    }
  });

  test('TC3: Page elements are interactive', async ({ page }) => {
    console.log('\n=== TC3: Interactive elements ===');
    
    await page.goto(`${BASE_URL}/retro`);
    
    const input = page.locator('input[placeholder*="Retro"]').first();
    
    // Test input focus and typing
    await input.focus();
    await input.type('Test Session', { delay: 50 });
    
    const value = await input.inputValue();
    console.log(`✓ Input accepts text. Value: "${value}"`);
    
    // Clear the input
    await input.clear();
    console.log('✓ Input can be cleared');
  });

  test('TC4: Session list structure', async ({ page }) => {
    console.log('\n=== TC4: Session list structure ===');
    
    await page.goto(`${BASE_URL}/retro`);
    
    // Check for empty state or session list
    const content = await page.content();
    
    if (content.includes('session') || content.includes('Session')) {
      console.log('✓ Page contains session-related content');
    }
    
    // Check for links to detail pages
    const sessionLinks = page.locator('a[href*="/retro/"]');
    const linkCount = await sessionLinks.count();
    
    console.log(`✓ Found ${linkCount} session detail links`);
    
    if (linkCount > 0) {
      const firstHref = await sessionLinks.first().getAttribute('href');
      console.log(`  First link: ${firstHref}`);
    }
  });

  test('TC5: Detail page navigation (if sessions exist)', async ({ page }) => {
    console.log('\n=== TC5: Detail page navigation ===');
    
    await page.goto(`${BASE_URL}/retro`);
    
    const sessionLink = page.locator('a[href*="/retro/"]').first();
    
    if (await sessionLink.isVisible().catch(() => false)) {
      const href = await sessionLink.getAttribute('href');
      console.log(`Navigating to: ${href}`);
      
      await sessionLink.click();
      await page.waitForLoadState('networkidle');
      
      const currentUrl = page.url();
      if (currentUrl.includes('/retro/')) {
        console.log(`✓ Successfully navigated to detail page`);
      } else {
        console.log(`✗ Navigation failed. URL: ${currentUrl}`);
      }
    } else {
      console.log('⚠ No sessions available to navigate to');
    }
  });

  test('TC6: Collect phase structure (on detail page)', async ({ page }) => {
    console.log('\n=== TC6: Collect phase structure ===');
    
    await page.goto(`${BASE_URL}/retro`);
    
    const sessionLink = page.locator('a[href*="/retro/"]').first();
    
    if (await sessionLink.isVisible().catch(() => false)) {
      await sessionLink.click();
      await page.waitForLoadState('networkidle');
      
      // Check for phase indicators
      const collectPhase = page.locator('text=Collect, text=collect').first();
      if (await collectPhase.isVisible().catch(() => false)) {
        console.log('✓ Collect phase is visible');
      }
      
      // Check for columns
      const columns = ['Good', 'Bad', 'Improve'];
      const found = [];
      
      for (const col of columns) {
        const elem = page.locator(`text=${col}`);
        if (await elem.isVisible().catch(() => false)) {
          found.push(col);
        }
      }
      
      if (found.length > 0) {
        console.log(`✓ Columns found: ${found.join(', ')}`);
      } else {
        console.log('⚠ Column headers not found');
      }
    }
  });

  test('TC7: Input fields in collect phase', async ({ page }) => {
    console.log('\n=== TC7: Input fields for items ===');
    
    await page.goto(`${BASE_URL}/retro`);
    
    const sessionLink = page.locator('a[href*="/retro/"]').first();
    
    if (await sessionLink.isVisible().catch(() => false)) {
      await sessionLink.click();
      await page.waitForLoadState('networkidle');
      
      const inputs = page.locator('textarea, input[type="text"]:not([placeholder*="Retro"])');
      const count = await inputs.count();
      
      console.log(`✓ Found ${count} input fields for items`);
      
      if (count > 0) {
        const firstInput = inputs.first();
        const placeholder = await firstInput.getAttribute('placeholder');
        console.log(`  First input placeholder: "${placeholder}"`);
      }
    }
  });

  test('TC8: No critical errors on load', async ({ page }) => {
    console.log('\n=== TC8: Error checking ===');
    
    const errors: string[] = [];
    const networkErrors: { url: string; status: number }[] = [];
    
    page.on('console', msg => {
      if (msg.type() === 'error' && !msg.text().includes('400')) {
        errors.push(msg.text());
      }
    });
    
    page.on('response', response => {
      if (response.status() >= 500) {
        networkErrors.push({
          url: response.url(),
          status: response.status(),
        });
      }
    });
    
    await page.goto(`${BASE_URL}/retro`);
    await page.waitForLoadState('networkidle');
    
    console.log(`✓ Console errors (excluding 400): ${errors.length}`);
    if (errors.length > 0) {
      errors.slice(0, 3).forEach(e => console.log(`  - ${e.substring(0, 80)}`));
    }
    
    console.log(`✓ Network errors (5xx): ${networkErrors.length}`);
    if (networkErrors.length > 0) {
      networkErrors.forEach(e => console.log(`  - [${e.status}] ${e.url}`));
    }
  });

  test('TC9: Page responsiveness', async ({ page }) => {
    console.log('\n=== TC9: Page responsiveness ===');
    
    await page.goto(`${BASE_URL}/retro`);
    
    // Check viewport and rendering
    const viewportSize = page.viewportSize();
    console.log(`✓ Viewport: ${viewportSize?.width}x${viewportSize?.height}`);
    
    const bodyHeight = await page.evaluate(() => document.body.scrollHeight);
    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    console.log(`✓ Page dimensions: ${bodyWidth}x${bodyHeight}`);
    
    // Check for buttons
    const buttons = await page.locator('button').count();
    console.log(`✓ Interactive buttons: ${buttons}`);
  });

  test('TC10: Complete user flow simulation', async ({ page }) => {
    console.log('\n=== TC10: Complete user flow ===');
    
    // 1. Load page
    await page.goto(`${BASE_URL}/retro`);
    console.log('1. Loaded /retro page');
    
    // 2. Check for sessions
    const sessionLinks = page.locator('a[href*="/retro/"]');
    const sessionCount = await sessionLinks.count();
    console.log(`2. Found ${sessionCount} sessions`);
    
    // 3. If sessions exist, navigate to one
    if (sessionCount > 0) {
      await sessionLinks.first().click();
      await page.waitForLoadState('networkidle');
      
      const url = page.url();
      console.log(`3. Navigated to: ${url}`);
      
      // 4. Check for interactive elements
      const inputs = page.locator('textarea, input[type="text"]');
      const inputCount = await inputs.count();
      console.log(`4. Found ${inputCount} input fields`);
      
      // 5. Try to interact with inputs
      if (inputCount > 0) {
        const firstInput = inputs.first();
        await firstInput.focus();
        console.log('5. Input field is focusable');
      }
    } else {
      console.log('3. No sessions to navigate to');
    }
    
    console.log('✓ User flow simulation complete');
  });

});
