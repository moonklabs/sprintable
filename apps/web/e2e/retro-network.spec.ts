import { test } from '@playwright/test';

const BASE_URL = 'http://localhost:3108';

test('Network: Capture all network requests on /retro', async ({ page }) => {
  console.log('\n=== Network Request Analysis ===');
  
  const requests: { url: string; status?: number; method: string }[] = [];
  const responses: { url: string; status: number }[] = [];
  
  page.on('request', request => {
    requests.push({
      url: request.url(),
      method: request.method(),
    });
  });
  
  page.on('response', response => {
    responses.push({
      url: response.url(),
      status: response.status(),
    });
  });
  
  // Navigate to retro page
  await page.goto(`${BASE_URL}/retro`, { waitUntil: 'networkidle' });
  
  // Get all failing requests (4xx, 5xx)
  const failing = responses.filter(r => r.status >= 400);
  console.log(`Total requests: ${responses.length}`);
  console.log(`Failed requests (4xx/5xx): ${failing.length}`);
  
  if (failing.length > 0) {
    console.log('\nFailing requests:');
    failing.forEach(r => {
      console.log(`  [${r.status}] ${r.url}`);
    });
  }
  
  // Check for API calls
  const apiCalls = responses.filter(r => r.url.includes('/api/'));
  console.log(`\nAPI calls made: ${apiCalls.length}`);
  apiCalls.slice(0, 10).forEach(r => {
    console.log(`  [${r.status}] ${r.url}`);
  });
});

test('Page Structure: Inspect DOM elements on /retro', async ({ page }) => {
  console.log('\n=== DOM Structure Analysis ===');
  
  await page.goto(`${BASE_URL}/retro`, { waitUntil: 'networkidle' });
  
  // Get the page content
  const html = await page.content();
  
  // Check for specific components
  const hasCreateButton = html.includes('New Session') || html.includes('Create');
  const hasInput = html.includes('input');
  const hasRetroHeading = html.includes('Sprint Retro') || html.includes('Retro');
  
  console.log(`Has "New Session" or "Create" button: ${hasCreateButton}`);
  console.log(`Has input elements: ${hasInput}`);
  console.log(`Has Retro heading: ${hasRetroHeading}`);
  
  // Check for error messages
  if (html.includes('HTTP 400')) {
    console.log('⚠ HTTP 400 error message found in page');
  }
  
  // Get all text content (excluding scripts/styles)
  const text = await page.locator('body').textContent();
  if (text) {
    // Count mentions of key words
    const retroCount = (text.match(/retro/gi) || []).length;
    const sessionCount = (text.match(/session/gi) || []).length;
    const errorCount = (text.match(/error/gi) || []).length;
    
    console.log(`Mentions - Retro: ${retroCount}, Session: ${sessionCount}, Error: ${errorCount}`);
  }
});

test('Interaction: Create a new retro session', async ({ page }) => {
  console.log('\n=== Create Retro Session Test ===');
  
  await page.goto(`${BASE_URL}/retro`, { waitUntil: 'networkidle' });
  
  // Get the session count before
  const sessionsBefore = await page.locator('[data-testid*="session"], [data-testid*="retro"], a[href*="/retro/"]').count();
  console.log(`Sessions before: ${sessionsBefore}`);
  
  // Find input and create button
  const input = page.locator('input').first();
  const createButton = page.locator('button:has-text("Create"), button:has-text("New")').nth(1);
  
  if (await input.isVisible()) {
    const newSessionTitle = `E2E Test Session ${Date.now()}`;
    console.log(`Filling input with: "${newSessionTitle}"`);
    
    await input.fill(newSessionTitle);
    
    // Try to click the button
    if (await createButton.isVisible()) {
      console.log('Clicking Create button');
      await createButton.click();
    } else {
      console.log('Create button not visible, trying Enter key');
      await input.press('Enter');
    }
    
    // Wait a bit and check
    await page.waitForTimeout(1000);
    
    // Check if session appears
    const sessionLink = page.locator(`a[href*="/retro/"], text=${newSessionTitle}`).first();
    if (await sessionLink.isVisible()) {
      console.log('✓ New session created and visible');
    } else {
      console.log('✗ New session not visible');
    }
  } else {
    console.log('✗ Input not visible');
  }
});
