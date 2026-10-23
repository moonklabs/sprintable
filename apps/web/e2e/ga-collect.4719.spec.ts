/**
 * story 4719 — what Google Analytics is actually SENT, measured in a real browser. The app runs with a placeholder measurement id and the
 * REAL gtag.js (the script itself is fetched from googletagmanager.com — a plain GET that carries only the placeholder measurement id, nothing of the
 * page); every BEACON to a Google Analytics host is intercepted (answered 204 — no page data leaves the machine) and recorded with its address and
 * body. A one-time value in an address (`?token=SECRET`) must appear in none of them — not in `dl` (the page address), not in `dr` (the
 * referrer), not in any other parameter or event field — on three roads: (1) the screen is the first one opened, (2) a same-site move
 * leaves a token screen, (3) an outbound link is clicked (while a token screen is open and after leaving it).
 *
 * Run: `pnpm e2e:ga` (own config: no sign-in, no backend, one worker; skips itself without GA_E2E_ID so the default e2e never runs it).
 * Reading the result: a control (`an ordinary screen is measured at all`) proves the harness sees the beacons — a harness that sees none
 * would pass everything. The automatic events of Google's «enhanced measurement» are defined in the property's own settings (the GA
 * admin), which a placeholder id does not carry: if the harness never sees such an event, that is said in the test's annotations, not hidden.
 */
import { expect, test, type BrowserContext, type Page, type Request } from '@playwright/test';

const SECRET = 'SECRET4719TOKEN';
const GA_HOSTS = /(^|\.)(google-analytics\.com|analytics\.google\.com|doubleclick\.net|googleadservices\.com|g\.doubleclick\.net)$/;

interface Beacon { url: string; body: string; at: number }

test.skip(!process.env['GA_E2E_ID'], 'a real-browser measurement: run it with `pnpm e2e:ga` (own config, placeholder measurement id)');

// The app's own CSP (next.config.ts) does NOT allow the tag today: `script-src` has no googletagmanager.com and `connect-src` no Google
// Analytics host, so a browser refuses to load gtag.js on the live site (measured here: the console says so, no beacon leaves). This harness
// answers the question that matters for the day GA is switched on: it adds those hosts to the CSP of the documents it loads (header
// rewritten in the browser's own request — the source is untouched) and then asks what GA would be sent. `GA_E2E_KEEP_CSP=1` keeps the CSP as it is.
const CSP_PATCH = process.env['GA_E2E_KEEP_CSP'] !== '1';

async function harness(context: BrowserContext) {
  const beacons: Beacon[] = [];
  const requested: string[] = [];
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
  context.on('request', (r: Request) => { requested.push(r.url()); });
  await context.route((u) => GA_HOSTS.test(u.hostname), async (route) => {
    const r = route.request();
    beacons.push({ url: r.url(), body: r.postData() ?? '', at: Date.now() });
    await route.fulfill({ status: 204, body: '' });
  });
  // the outbound link goes to a page we serve ourselves — no real navigation to a third party
  await context.route('https://example.org/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>outbound</title>ok' }));
  return { beacons, requested };
}

/** every character of every beacon, decoded: url + body, percent-decoded twice (a value may be encoded inside an encoded parameter) */
function haystack(b: Beacon[]): string {
  const dec = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
  return b.map((x) => dec(dec(x.url)) + '\n' + dec(dec(x.body))).join('\n');
}

function param(b: Beacon, name: string): string[] {
  const out: string[] = [];
  const from = (qs: string) => { for (const [k, v] of new URLSearchParams(qs)) if (k === name) out.push(v); };
  from(new URL(b.url).search);
  for (const line of b.body.split('\n')) if (line.includes('=')) from(line);
  return out;
}

async function settle(page: Page, ms = 2500) { await page.waitForTimeout(ms); }

/** any hit GA decides to send (an automatic event of the property, a conversion …) is made by gtag; an explicit event stands for it: it carries
 *  whatever page location / referrer GA holds at that moment. Develop's component leaves the real address (token and all) there on a token screen. */
async function probe(page: Page) {
  await page.evaluate(() => (window as unknown as { gtag?: (...a: unknown[]) => void }).gtag?.('event', 'qa_probe', { probe: 'x' }));
}

/** gtag queues events and sends them in batches (and when the page is hidden): leave the document so everything queued is sent, then wait */
async function flush(page: Page) {
  await page.goto('about:blank');
  await page.waitForTimeout(2000);
}

test.describe('Google Analytics beacons carry no one-time value (story 4719)', () => {
  test('fact: what the app\'s own CSP says about the tag (served as it is)', async ({ request }) => {
    const res = await request.get('/forgot-password');
    const csp = res.headers()['content-security-policy'] ?? '';
    const script = /script-src ([^;]*)/.exec(csp)?.[1] ?? '';
    const connect = /connect-src ([^;]*)/.exec(csp)?.[1] ?? '';
    test.info().annotations.push({ type: 'csp-script-src-allows-googletagmanager', description: String(/googletagmanager\.com/.test(script)) });
    test.info().annotations.push({ type: 'csp-connect-src-allows-google-analytics', description: String(/google-analytics\.com|analytics\.google\.com/.test(connect)) });
  });

  test('control: the harness sees a beacon at all — an explicit event, then an ordinary screen with no query in its address', async ({ context }) => {
    const { beacons } = await harness(context);
    const page = await context.newPage();
    await page.goto('/forgot-password?probe=PROBE4719');
    await settle(page, 4000);
    const fromScreen = beacons.length;
    await probe(page);
    await flush(page);
    test.info().annotations.push({ type: 'beacons-from-the-screen-itself', description: String(fromScreen) });
    test.info().annotations.push({ type: 'beacons-after-an-explicit-event-and-a-flush', description: String(beacons.length - fromScreen) });
    test.info().annotations.push({ type: 'events', description: [...new Set(beacons.flatMap((b) => param(b, 'en')))].join(',') });
    expect(beacons.flatMap((b) => param(b, 'en')), 'the explicit probe event itself produced a beacon').toContain('qa_probe');
    expect(beacons.length, 'the harness must see the beacons of an explicit event (else it proves nothing)').toBeGreaterThan(0);
    const dls = beacons.flatMap((b) => param(b, 'dl'));
    expect(dls.length).toBeGreaterThan(0);
    for (const dl of dls) expect(dl).not.toMatch(/[?#]/);
    expect(haystack(beacons)).not.toContain('PROBE4719');
  });

  test('road 1 — the first screen opened is a token screen: the tag is not even loaded, no beacon at all', async ({ context }) => {
    const { beacons, requested } = await harness(context);
    const page = await context.newPage();
    await page.goto(`/reset-password?token=${SECRET}`);
    await settle(page, 4000);
    expect(requested.filter((u) => /googletagmanager\.com\/gtag\/js/.test(u))).toHaveLength(0);
    expect(beacons).toHaveLength(0);
    expect(requested.filter((u) => decodeURIComponent(u).includes(SECRET) && !u.startsWith('http://localhost'))).toEqual([]);
  });

  test('road 1b — a code in the # part of an app screen: the tag is not loaded and nothing is measured', async ({ context }) => {
    const { beacons, requested } = await harness(context);
    const page = await context.newPage();
    await page.goto(`/forgot-password#code=${SECRET}`);
    await settle(page, 4000);
    expect(requested.filter((u) => /googletagmanager\.com\/gtag\/js/.test(u))).toHaveLength(0);
    expect(beacons).toHaveLength(0);
    expect(haystack(beacons)).not.toContain(SECRET);
  });

  test('road 1c — a public share link carries its secret in the PATH: the tag is not loaded, and the next screen does not get the path as its referrer', async ({ context }) => {
    const { beacons, requested } = await harness(context);
    const page = await context.newPage();
    await page.goto(`/share/${SECRET}`);
    await settle(page, 4000);
    expect(requested.filter((u) => /googletagmanager\.com\/gtag\/js/.test(u))).toHaveLength(0);
    expect(beacons).toHaveLength(0);
    // an ordinary screen opened next in the same page (a real client-side move needs a link; a full load is the strict case)
    await page.goto('/forgot-password');
    await settle(page, 4000);
    expect(haystack(beacons)).not.toContain(SECRET);
  });

  test('road 2 — an ordinary screen → a token screen → the next same-site screen: the token is in no beacon (dl · dr · anything)', async ({ context }) => {
    const { beacons } = await harness(context);
    const page = await context.newPage();
    await page.goto('/forgot-password');
    await settle(page, 3500);
    const before = beacons.length;
    expect(before, 'the control screen is measured (else this proves nothing)').toBeGreaterThan(0);

    // a real client-side move to the token screen (the app router, as a link would)
    await page.evaluate((s) => (window as unknown as { next: { router: { push: (u: string) => void } } }).next.router.push(`/reset-password?token=${s}`), SECRET);
    await page.waitForURL(new RegExp(`reset-password\\?token=${SECRET}`));
    await settle(page, 3000);
    await probe(page); // a hit made while the token screen is open

    // … and the move that leaves it: the page has no link while a token is in its address, so the real app router makes the same client-side move a link would
    await page.evaluate(() => (window as unknown as { next: { router: { push: (u: string) => void } } }).next.router.push('/forgot-password'));
    await page.waitForURL(/forgot-password/);
    await settle(page, 3000);
    await probe(page); // a hit made right after leaving it
    await flush(page);

    test.info().annotations.push({ type: 'beacons-total', description: String(beacons.length) });
    expect(haystack(beacons), 'the token must not be in any beacon').not.toContain(SECRET);
    for (const b of beacons) for (const k of ['dl', 'dr']) for (const v of param(b, k)) expect(v, `${k} of ${b.url.slice(0, 120)}`).not.toMatch(/[?#]/);
    // the token screen itself was not measured: no beacon names it
    expect(haystack(beacons)).not.toContain('reset-password');
  });

  test('road 3 — an outbound link clicked while a token screen is open and after leaving it: no token in any beacon', async ({ context }) => {
    const { beacons } = await harness(context);
    const page = await context.newPage();
    await page.goto('/forgot-password');
    await settle(page, 3500);
    expect(beacons.length, 'the control screen is measured (else this proves nothing)').toBeGreaterThan(0);
    await page.evaluate((s) => (window as unknown as { next: { router: { push: (u: string) => void } } }).next.router.push(`/reset-password?token=${s}`), SECRET);
    await page.waitForURL(new RegExp(`reset-password\\?token=${SECRET}`));
    await settle(page, 2500);
    await probe(page);

    // on the token screen: a link to another site, clicked
    await page.evaluate(() => { const a = document.createElement('a'); a.id = 'out1'; a.href = 'https://example.org/ga-4719-out'; a.textContent = 'out'; document.body.appendChild(a); });
    await page.locator('#out1').click();
    await page.waitForURL(/example\.org/);
    await settle(page, 2500);

    // back to the app on an ordinary screen (a new document: the tag starts again) and click another outbound link there
    await page.goto('/forgot-password');
    await settle(page, 3500);
    await page.evaluate(() => { const a = document.createElement('a'); a.id = 'out2'; a.href = 'https://example.org/ga-4719-out2'; a.textContent = 'out'; document.body.appendChild(a); });
    await page.locator('#out2').click();
    await page.waitForURL(/example\.org/);
    await settle(page, 2500);
    await flush(page);

    expect(haystack(beacons), 'the token must not be in any beacon').not.toContain(SECRET);
    for (const b of beacons) for (const k of ['dl', 'dr']) for (const v of param(b, k)) expect(v).not.toMatch(/[?#]/);
  });

  test('automatic events: say whether the harness ever saw one (enhanced measurement lives in the GA admin, not in the placeholder id)', async ({ context }) => {
    const { beacons } = await harness(context);
    const page = await context.newPage();
    await page.goto('/forgot-password');
    await settle(page, 3000);
    await page.evaluate(() => { const a = document.createElement('a'); a.id = 'out3'; a.href = 'https://example.org/ga-4719-auto'; a.textContent = 'out'; document.body.appendChild(a); });
    await page.locator('#out3').click();
    await page.waitForURL(/example\.org/);
    await settle(page, 2500);
    const events = beacons.flatMap((b) => param(b, 'en'));
    expect(beacons.length, 'the harness sees the beacons of an ordinary screen (else this proves nothing)').toBeGreaterThan(0);
    test.info().annotations.push({ type: 'events-seen', description: [...new Set(events)].join(',') || '(none)' });
    const automatic = events.filter((e) => ['click', 'scroll', 'file_download', 'video_start', 'form_start', 'form_submit', 'page_view'].includes(e));
    test.info().annotations.push({ type: 'automatic-events-seen', description: [...new Set(automatic)].join(',') || '(none)' });
    expect(haystack(beacons)).not.toMatch(/[?&]token=/);
    expect(haystack(beacons)).not.toContain(SECRET);
  });
});
