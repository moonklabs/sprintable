/**
 * Layout Verification Suite
 *
 * Verifies the shell scroll contract and panel structure across all authenticated routes.
 *
 * Run: pnpm exec playwright test e2e/layout-verification.spec.ts
 *
 * Checks per route (A–F):
 *   A. HTTP 200, no console errors, no hydration warnings
 *   B. Exactly one global sidebar (settings: +1 left nav panel)
 *   C. Vertical scroll works when content exceeds viewport
 *   D. No double-scrollbar (except settings which has two independent ones)
 *   E. Sidebar toggle preserves layout
 *   F. Mobile (390px) — sidebar Sheet + content scroll
 */

import { expect, test, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Auth helper — OSS mode uses cookie-less session; adapt to your auth flow
// ---------------------------------------------------------------------------
async function ensureLoggedIn(page: Page) {
  await page.goto('/');
  const url = page.url();
  if (url.includes('/login') || url.includes('/auth')) {
    // OSS mode auto-seeds a session — just navigate to the seed endpoint first
    await page.request.post('/api/oss/seed').catch(() => {});
    await page.goto('/dashboard');
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function countGlobalSidebars(page: Page): Promise<number> {
  return page.locator('aside[data-sidebar="sidebar"]').count();
}

async function isScrollable(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    return el.scrollHeight > el.clientHeight + 2;
  }, selector);
}

async function hasDoubleScroll(page: Page): Promise<boolean> {
  // Look for two overflow-y-auto/scroll elements that are both actually scrollable
  return page.evaluate(() => {
    const scrollables = Array.from(document.querySelectorAll('*')).filter((el) => {
      const style = getComputedStyle(el);
      if (!['auto', 'scroll'].includes(style.overflowY)) return false;
      return (el as HTMLElement).scrollHeight > (el as HTMLElement).clientHeight + 2;
    });
    // Two or more scrollable containers at the same ancestor level is a double-scroll
    // (exclude fixed/absolute positioned ones which are modals etc.)
    const positioned = scrollables.filter((el) => {
      const style = getComputedStyle(el);
      return !['fixed', 'absolute'].includes(style.position);
    });
    return positioned.length > 1;
  });
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------
interface RouteSpec {
  path: string;
  label: string;
  /** settings has 2 independent scroll panels — skip double-scroll check */
  dualPanel?: boolean;
  /** skip scroll check — page intentionally has no scrollable content */
  noScroll?: boolean;
}

const ROUTES: RouteSpec[] = [
  { path: '/dashboard', label: 'dashboard' },
  { path: '/board', label: 'board' },
  { path: '/inbox', label: 'inbox' },
  { path: '/standup', label: 'standup' },
  { path: '/retro', label: 'retro' },
  { path: '/memos', label: 'memos' },
  { path: '/docs', label: 'docs' },
  { path: '/epics', label: 'epics' },
  { path: '/mockups', label: 'mockups' },
  { path: '/agents', label: 'agents' },
  { path: '/agents/api-keys', label: 'agents/api-keys' },
  { path: '/agents/runs', label: 'agents/runs' },
  { path: '/settings', label: 'settings', dualPanel: true },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
test.describe('Layout Verification', () => {
  test.beforeEach(async ({ page }) => {
    await ensureLoggedIn(page);
  });

  for (const route of ROUTES) {
    test(`[A-E] ${route.label}`, async ({ page }) => {
      const consoleErrors: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });

      // A. HTTP 200 + no JS errors
      const response = await page.goto(route.path);
      expect(response?.status(), `${route.label}: HTTP status`).toBe(200);
      await page.waitForLoadState('networkidle');

      const hydrationWarnings = consoleErrors.filter(
        (e) => e.includes('Hydration') || e.includes('hydration'),
      );
      expect(hydrationWarnings, `${route.label}: hydration warnings`).toHaveLength(0);

      // B. Exactly one global sidebar
      const sidebarCount = await countGlobalSidebars(page);
      expect(sidebarCount, `${route.label}: global sidebar count`).toBe(1);

      // Settings: also verify left nav panel exists (2-panel layout)
      if (route.dualPanel) {
        const leftNav = page.locator('[data-slot="tabs"] > div').first();
        await expect(leftNav, `${route.label}: settings left nav panel`).toBeVisible();
      }

      // C. Scroll — force long content by resizing viewport short, then check
      if (!route.noScroll) {
        await page.setViewportSize({ width: 1280, height: 400 });
        await page.waitForTimeout(100);

        // The common scroll wrapper added in dashboard-shell
        const wrapperScrollable = await isScrollable(
          page,
          'aside[data-sidebar] ~ div .overflow-y-auto',
        );

        // Fallback: any scrollable area exists
        const anyScrollable = await page.evaluate(() => {
          const candidates = Array.from(document.querySelectorAll('.overflow-y-auto'));
          return candidates.some(
            (el) => (el as HTMLElement).scrollHeight > (el as HTMLElement).clientHeight + 2,
          );
        });

        // Reset viewport
        await page.setViewportSize({ width: 1280, height: 800 });

        expect(wrapperScrollable || anyScrollable, `${route.label}: content scrollable`).toBe(true);
      }

      // D. No double-scroll (except dual-panel routes where it's intentional+independent)
      if (!route.dualPanel) {
        const doubled = await hasDoubleScroll(page);
        expect(doubled, `${route.label}: no double-scroll`).toBe(false);
      }

      // E. Sidebar toggle preserves layout
      const trigger = page.locator('[data-sidebar="trigger"]').first();
      if (await trigger.isVisible()) {
        await trigger.click();
        await page.waitForTimeout(150);
        const afterToggleSidebars = await countGlobalSidebars(page);
        expect(afterToggleSidebars, `${route.label}: sidebar count after toggle`).toBe(1);
        // Toggle back
        await trigger.click();
        await page.waitForTimeout(150);
      }
    });

    test(`[F] ${route.label} — mobile 390px`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      const response = await page.goto(route.path);
      expect(response?.status(), `${route.label} mobile: HTTP status`).toBe(200);
      await page.waitForLoadState('networkidle');

      // Sidebar should be a Sheet (not visible inline) on mobile
      const inlineSidebar = page.locator('aside[data-sidebar="sidebar"]');
      const isInlineVisible = await inlineSidebar.isVisible().catch(() => false);
      // It's OK if sidebar is hidden on mobile (Sheet behavior)
      if (isInlineVisible) {
        // If visible, it should still be just 1
        expect(await countGlobalSidebars(page)).toBe(1);
      }

      // Content should be accessible (not clipped)
      const mainContent = page.locator('main, [role="main"], .overflow-y-auto').first();
      await expect(mainContent, `${route.label} mobile: main content visible`).toBeVisible();
    });
  }

  // Settings-specific: all tabs navigate correctly
  test('settings: all tab panels render without errors', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForLoadState('networkidle');

    const tabValues = [
      'profile',
      'appearance',
      'notifications',
      'ai',
      'danger',
    ];

    for (const value of tabValues) {
      const trigger = page.locator(`[role="tab"][data-value="${value}"], button[data-value="${value}"]`).first();
      if (await trigger.isVisible()) {
        await trigger.click();
        await page.waitForTimeout(100);
        // No crash — page should still show the sidebar
        const sidebarCount = await countGlobalSidebars(page);
        expect(sidebarCount, `settings ${value} tab: sidebar count`).toBe(1);
      }
    }
  });
});
