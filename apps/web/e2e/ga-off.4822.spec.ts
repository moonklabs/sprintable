/**
 * story 4822 — «with DISABLE_ANALYTICS=true the app sends nothing to Google», measured in a real browser. Two copies of the app run with the same placeholder measurement
 * id baked in (`playwright.ga-off.config.ts`): the switch ON (OFF_PORT) and the switch unset (ON_PORT — the control). The browser's own page is the thing under test; the Google
 * hosts are answered by this harness (an empty script, an empty 204), so nothing leaves the machine and every request that WOULD have gone there is recorded.
 *
 * Reading the result: the control («the tag is requested when the switch is unset») proves the harness sees such requests — a harness that saw none would pass everything. The
 * app's own CSP does not allow the tag today (script-src has no googletagmanager.com — story 4719), so the harness widens the CSP of the documents it loads (the header is
 * rewritten in the browser's own request, the source is untouched) to answer the question that matters for the day the CSP allows it. `GA_E2E_KEEP_CSP=1` keeps the CSP.
 *
 * Run: `pnpm e2e:ga-off`. The count that must be 0: requests to googletagmanager.com / google-analytics.com / analytics.google.com / doubleclick.net on four screens and one
 * client-side move, plus no gtag script in the page, no `window.gtag` / `window.dataLayer`, no `_ga` cookie.
 */
import { expect, test, type BrowserContext, type Page, type Request } from '@playwright/test';

test.skip(!process.env['GA_OFF_E2E'], 'a real-browser measurement: run it with `pnpm e2e:ga-off` (own config, placeholder measurement id)');

const MODE = process.env['GA_MODE'] === 'on' ? 'on' : 'off';
const BASE = `http://localhost:${process.env['GA_PORT'] ?? '3421'}`;
const GOOGLE = /(^|\.)(googletagmanager\.com|google-analytics\.com|analytics\.google\.com|doubleclick\.net|googleadservices\.com)$/;
const CSP_PATCH = process.env['GA_E2E_KEEP_CSP'] !== '1';
const SCREENS = ['/forgot-password', '/login', '/register', '/forgot-password?probe=1'];

async function harness(context: BrowserContext) {
  const toGoogle: string[] = [];
  if (CSP_PATCH) {
    await context.route((u) => u.hostname === 'localhost', async (route) => {
      if (route.request().resourceType() !== 'document') return route.fallback();
      const response = await route.fetch();
      const headers = { ...response.headers() };
      const csp = headers['content-security-policy'];
      if (csp) {
        headers['content-security-policy'] = csp
          .replace('script-src ', 'script-src https://www.googletagmanager.com ')
          .replace('connect-src ', 'connect-src https://www.googletagmanager.com https://*.google-analytics.com https://*.analytics.google.com ');
      }
      await route.fulfill({ response, headers });
    });
  }
  context.on('request', (r: Request) => { try { if (GOOGLE.test(new URL(r.url()).hostname)) toGoogle.push(r.method() + ' ' + new URL(r.url()).origin + new URL(r.url()).pathname); } catch { /* not an address */ } });
  await context.route((u) => GOOGLE.test(u.hostname), async (route) => {
    if (route.request().resourceType() === 'script') await route.fulfill({ status: 200, contentType: 'text/javascript', body: '/* harness: the tag is not fetched */' });
    else await route.fulfill({ status: 204, body: '' });
  });
  return { toGoogle };
}

async function pageFacts(page: Page) {
  return page.evaluate(() => ({
    gtagScripts: document.querySelectorAll('script[src*="googletagmanager"], script#ga4-init').length,
    hasGtag: typeof (window as unknown as { gtag?: unknown }).gtag !== 'undefined',
    hasDataLayer: typeof (window as unknown as { dataLayer?: unknown }).dataLayer !== 'undefined',
    gaCookies: document.cookie.split(';').map((c) => c.trim()).filter((c) => /^_ga/.test(c)).length,
  }));
}

test('control: with the switch unset the tag is requested (the harness sees it)', async ({ browser }) => {
  test.skip(MODE !== 'on', 'run with GA_MODE=on (the app without the switch)');
  const context = await browser.newContext();
  const { toGoogle } = await harness(context);
  const page = await context.newPage();
  await page.goto(`${BASE}/forgot-password`);
  await page.waitForTimeout(4000);
  const facts = await pageFacts(page);
  test.info().annotations.push({ type: 'control', description: `requests to Google: ${toGoogle.length} (${[...new Set(toGoogle)].join(', ')}); gtag scripts in the page: ${facts.gtagScripts}` });
  expect(toGoogle.some((r) => r.includes('googletagmanager.com/gtag/js'))).toBe(true);
  expect(facts.gtagScripts).toBeGreaterThan(0);
  expect(facts.hasGtag).toBe(true);
  await context.close();
});

test('DISABLE_ANALYTICS=true: zero requests to Google on four screens and a client-side move, no tag in the page', async ({ browser }) => {
  test.skip(MODE !== 'off', 'run with GA_MODE=off (the app with DISABLE_ANALYTICS=true)');
  const context = await browser.newContext();
  const { toGoogle } = await harness(context);
  const page = await context.newPage();
  const seen: Record<string, unknown> = {};
  for (const path of SCREENS) {
    await page.goto(`${BASE}${path}`);
    await page.waitForTimeout(3000);
    seen[path] = await pageFacts(page);
  }
  // a client-side move (the tag, when it is there, reports the new screen on a route change)
  await page.goto(`${BASE}/login`);
  await page.waitForTimeout(1500);
  await page.evaluate(() => (window as unknown as { next: { router: { push: (u: string) => void } } }).next.router.push('/forgot-password'));
  await page.waitForURL(/forgot-password/);
  await page.waitForTimeout(3000);
  seen['(client-side move)'] = await pageFacts(page);
  test.info().annotations.push({ type: 'measurement', description: `requests to Google: ${toGoogle.length}; page facts: ${JSON.stringify(seen)}` });
  expect(toGoogle, 'every request that went to a Google host').toEqual([]);
  for (const [where, f] of Object.entries(seen)) {
    expect(f, where).toEqual({ gtagScripts: 0, hasGtag: false, hasDataLayer: false, gaCookies: 0 });
  }
  await context.close();
});
