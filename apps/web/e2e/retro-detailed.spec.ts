import { test, expect } from '@playwright/test';

const BASE_URL = 'http://localhost:3108';

test.describe('Sprint Retro - Detailed E2E Tests', () => {
  
  test('Detailed: Load retro page and capture structure', async ({ page }) => {
    console.log('\n=== Test: Load /retro page ===');
    
    // Navigate to retro
    const response = await page.goto(`${BASE_URL}/retro`, { waitUntil: 'networkidle' });
    console.log('Status:', response?.status());
    
    // Check page title
    const title = await page.title();
    console.log('Page title:', title);
    
    // Get all headings
    const headings = await page.locator('h1, h2, h3').allTextContents();
    console.log('Headings found:', headings.slice(0, 5));
    
    // Check for input fields
    const inputs = await page.locator('input').count();
    const textareas = await page.locator('textarea').count();
    const buttons = await page.locator('button').count();
    console.log(`Form elements - Inputs: ${inputs}, Textareas: ${textareas}, Buttons: ${buttons}`);
    
    // Get visible text content
    const visibleText = await page.locator('body').textContent();
    if (visibleText?.includes('Retro') || visibleText?.includes('retro')) {
      console.log('✓ Retro content found on page');
    } else {
      console.log('✗ Retro content NOT found on page');
    }
    
    // Check for session creation
    const createSessionForm = page.locator('[placeholder*="name" i], [placeholder*="title" i], label:has-text("Title"), label:has-text("Name")');
    const formCount = await createSessionForm.count();
    console.log(`Create form elements found: ${formCount}`);
    
    // List all visible buttons
    const allButtons = await page.locator('button').allTextContents();
    console.log('Visible buttons:', allButtons.slice(0, 10));
  });

  test('Detailed: Session list interaction', async ({ page }) => {
    console.log('\n=== Test: Session list interaction ===');
    
    await page.goto(`${BASE_URL}/retro`, { waitUntil: 'networkidle' });
    
    // Look for session cards/links
    const allLinks = await page.locator('a').allTextContents();
    console.log('Links on page:', allLinks.slice(0, 15));
    
    const retroLinks = await page.locator('a[href*="/retro/"]').count();
    console.log(`Session links found: ${retroLinks}`);
    
    if (retroLinks > 0) {
      const firstLink = page.locator('a[href*="/retro/"]').first();
      const href = await firstLink.getAttribute('href');
      const text = await firstLink.textContent();
      console.log(`✓ First session link - href: ${href}, text: ${text}`);
    } else {
      console.log('✗ No session links found');
    }
    
    // Check for empty state
    const emptyState = page.locator('text=No retro, text=No sessions, text=Empty, text=Create your first');
    const emptyCount = await emptyState.count();
    console.log(`Empty state elements: ${emptyCount}`);
  });

  test('Detailed: Retro session detail page', async ({ page }) => {
    console.log('\n=== Test: Retro session detail page ===');
    
    await page.goto(`${BASE_URL}/retro`, { waitUntil: 'networkidle' });
    
    // Try to find and click first session
    const firstSession = page.locator('a[href*="/retro/"]').first();
    if (await firstSession.isVisible()) {
      const href = await firstSession.getAttribute('href');
      console.log(`Navigating to: ${href}`);
      
      await page.goto(`${BASE_URL}${href}`, { waitUntil: 'networkidle' });
      console.log(`✓ Navigated to detail page`);
      
      // Check URL
      console.log(`Current URL: ${page.url()}`);
      
      // Look for phase/step indicators
      const phases = ['Collect', 'Group', 'Vote', 'Discuss', 'Action', 'Closed'];
      for (const phase of phases) {
        const element = page.locator(`text=${phase}`);
        if (await element.isVisible()) {
          console.log(`✓ Phase "${phase}" found`);
        }
      }
      
      // Check for columns
      const columns = ['Good', 'Bad', 'Improve', 'Positive', 'Negative'];
      for (const col of columns) {
        const element = page.locator(`text=${col}`);
        if (await element.isVisible()) {
          console.log(`✓ Column "${col}" found`);
        }
      }
      
      // Check for input fields
      const inputs = await page.locator('input[type="text"], textarea').count();
      console.log(`Input fields: ${inputs}`);
      
      // Check buttons for adding items
      const buttons = await page.locator('button').allTextContents();
      const addButtons = buttons.filter(b => b.toLowerCase().includes('add') || b.toLowerCase().includes('submit') || b.toLowerCase().includes('send'));
      console.log('Action buttons:', buttons.slice(0, 8));
    } else {
      console.log('✗ No session found to navigate to');
    }
  });

  test('Detailed: Add item to retro session', async ({ page }) => {
    console.log('\n=== Test: Add item to retro session ===');
    
    await page.goto(`${BASE_URL}/retro`, { waitUntil: 'networkidle' });
    
    const firstSession = page.locator('a[href*="/retro/"]').first();
    if (await firstSession.isVisible()) {
      const href = await firstSession.getAttribute('href');
      await page.goto(`${BASE_URL}${href}`, { waitUntil: 'networkidle' });
      
      // Try to find input and add item
      const inputs = page.locator('input[type="text"], textarea');
      const inputCount = await inputs.count();
      console.log(`Found ${inputCount} input fields`);
      
      if (inputCount > 0) {
        const firstInput = inputs.first();
        const placeholder = await firstInput.getAttribute('placeholder');
        console.log(`First input placeholder: ${placeholder}`);
        
        // Try to fill and submit
        const testItem = `Test item ${Date.now()}`;
        await firstInput.fill(testItem);
        
        // Look for submit button near input
        const parent = firstInput.locator('..');
        const btn = parent.locator('button').first();
        
        if (await btn.isVisible()) {
          const btnText = await btn.textContent();
          console.log(`Found button: ${btnText}`);
          await btn.click();
          console.log('✓ Item submitted');
        } else {
          // Try pressing Enter
          await firstInput.press('Enter');
          console.log('✓ Item submitted via Enter key');
        }
        
        // Wait and check if item appears
        await page.waitForTimeout(500);
        const itemElement = page.locator(`text=${testItem}`);
        if (await itemElement.isVisible()) {
          console.log('✓ Item appears in list');
        } else {
          console.log('⚠ Item not visible after submission');
        }
      }
    }
  });

  test('Detailed: Phase transition', async ({ page }) => {
    console.log('\n=== Test: Phase transition ===');
    
    await page.goto(`${BASE_URL}/retro`, { waitUntil: 'networkidle' });
    
    const firstSession = page.locator('a[href*="/retro/"]').first();
    if (await firstSession.isVisible()) {
      const href = await firstSession.getAttribute('href');
      await page.goto(`${BASE_URL}${href}`, { waitUntil: 'networkidle' });
      
      // Check current phase
      let currentPhase = 'Unknown';
      const phases = ['Collect', 'Group', 'Vote', 'Discuss', 'Action', 'Closed'];
      for (const phase of phases) {
        const element = page.locator(`text=${phase}`);
        if (await element.isVisible()) {
          currentPhase = phase;
          break;
        }
      }
      console.log(`Current phase: ${currentPhase}`);
      
      // Look for next phase button
      const nextBtn = page.locator('button:has-text("Next"), button:has-text("Continue"), button:has-text("Proceed")').first();
      if (await nextBtn.isVisible()) {
        const btnText = await nextBtn.textContent();
        console.log(`✓ Next button found: "${btnText}"`);
        
        // Click it
        await nextBtn.click();
        await page.waitForTimeout(800);
        console.log('✓ Clicked next phase button');
        
        // Check if phase changed
        for (const phase of phases) {
          const element = page.locator(`text=${phase}`);
          if (await element.isVisible()) {
            console.log(`New phase: ${phase}`);
            break;
          }
        }
      } else {
        console.log('✗ Next phase button not found');
      }
    }
  });

  test('Detailed: Console error detection', async ({ page }) => {
    console.log('\n=== Test: Console error detection ===');
    
    const errors: string[] = [];
    const warnings: string[] = [];
    
    page.on('console', msg => {
      const text = msg.text();
      if (msg.type() === 'error') {
        errors.push(text);
      } else if (msg.type() === 'warning') {
        warnings.push(text);
      }
    });
    
    await page.goto(`${BASE_URL}/retro`, { waitUntil: 'networkidle' });
    
    console.log(`Console errors: ${errors.length}`);
    errors.slice(0, 5).forEach(e => console.log(`  - ${e}`));
    
    console.log(`Console warnings: ${warnings.length}`);
    warnings.slice(0, 5).forEach(w => console.log(`  - ${w}`));
  });
});
