/**
 * story #4446 — «시작» on the desktop setup page is in sight right after sign-in, with no scrolling, in both of its modes and
 * their real parent chains: (가) an existing organization (inside the app shell: an inner area scrolls) and (나) a new
 * organization (no shell: the window scrolls). Before the fix it sat 1041px below the fold in the app's own window (1440×900)
 * and a person saw «no agent starts» (선생님 10-01 00:15Z).
 *
 * The viewport is the app's web area: the desktop app's window minus the shell's bottom bar («이 컴퓨터의 에이전트», 64px —
 * measured: a 1440×900 window shows the web at 1440×836). The long list is the real one (the platform recipes the migrations
 * seed); a short list would hide the scroll this guards, so the test refuses to run on fewer than 8. With the list opened
 * ([바꾸기]) «시작» must still be in sight — that is the sticky row, not the fold, holding it.
 */
import { createHmac } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';

const CODE = `${'A'.repeat(20)}_-${'b'.repeat(21)}`;
const SETUP = `/desktop/setup#code=${CODE}&setup=s-e2e-4446&runtimes=claude,codex`;
const BAR = 64; // the shell's bottom bar under the web area
const WINDOWS = [
  { w: 1440, h: 900 }, // the app's own window
  { w: 1280, h: 700 },
  { w: 1512, h: 860 },
];

type Sight = { found: boolean; inSight: boolean; top: number; bottom: number; visibleBottom: number; scroller: string };

/** Where «시작» is against the visible part of whatever scrolls it (the window or an inner area), with nothing scrolled. */
async function startInSight(page: Page): Promise<Sight> {
  return page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === '시작');
    if (!b) return { found: false, inSight: false, top: 0, bottom: 0, visibleBottom: 0, scroller: '' };
    let s: HTMLElement | null = b.parentElement;
    while (s && !(/(auto|scroll)/.test(getComputedStyle(s).overflowY) && s.scrollHeight > s.clientHeight)) s = s.parentElement;
    const r = b.getBoundingClientRect();
    const view = s ? s.getBoundingClientRect() : { top: 0, bottom: innerHeight };
    const visibleBottom = Math.min(view.bottom, innerHeight);
    return { found: true, inSight: r.top >= Math.max(0, view.top) && r.bottom <= visibleBottom, top: Math.round(r.top), bottom: Math.round(r.bottom), visibleBottom: Math.round(visibleBottom), scroller: s ? s.tagName.toLowerCase() : 'window' };
  });
}

async function openSetup(page: Page) {
  // a fresh page each time: the same path with a new fragment is only a hash change (state would carry over)
  await page.goto('about:blank');
  await page.goto(SETUP);
  await expect(page.getByRole('button', { name: '시작', exact: true })).toBeVisible({ timeout: 60_000 });
}

async function check(page: Page, mode: string) {
  for (const win of WINDOWS) {
    await page.setViewportSize({ width: win.w, height: win.h - BAR });
    await openSetup(page);
    const label = `${mode} · ${win.w}×${win.h} window`;
    // the mode this case is about, for real (a wrong account would otherwise measure the other page)
    await expect(page.getByTestId('setup-new-org'), label).toHaveCount(mode === 'new-org' ? 1 : 0);
    // the chosen recipe is one card with [바꾸기] (the long list is folded)
    await expect(page.getByTestId('setup-recipe-chosen'), label).toBeVisible();
    await expect(page.getByTestId('setup-recipe-list'), label).toHaveCount(0);
    const folded = await startInSight(page);
    expect(folded, `${label}: «시작» in sight with nothing scrolled`).toMatchObject({ found: true, inSight: true });
    // positive control on the long list: open it — «시작» stays in sight (the sticky row), and the list really is long
    await page.getByTestId('setup-recipe-chosen').getByRole('button').click();
    const list = page.getByTestId('setup-recipe-list');
    await expect(list).toBeVisible();
    const n = await list.locator('input[name=recipe]').count();
    expect(n, 'the real recipe list (a short one would hide the scroll this guards)').toBeGreaterThanOrEqual(8);
    const opened = await startInSight(page);
    expect(opened, `${label}: «시작» still in sight with the ${n}-recipe list open`).toMatchObject({ found: true, inSight: true });
    await page.screenshot({ path: test.info().outputPath(`4446-${mode}-${win.w}x${win.h}.png`) }); // test-results/, never the repo
  }
}

test.describe('[SID:4446] desktop setup — «시작» in sight without scrolling', () => {
  // three window sizes × a fresh page each (and the list opened) per test: more than the 30s default on a cold server
  test.setTimeout(120_000);

  test('(가) an existing organization — inside the app shell', async ({ browser }) => {
    const context = await browser.newContext({ storageState: 'playwright/.auth/owner.json', locale: 'ko-KR' });
    const page = await context.newPage();
    await check(page, 'existing-org');
    await context.close();
  });

  test('(나) a new organization — a person with none yet (the window scrolls)', async ({ browser, baseURL }) => {
    const page = await newPersonPage(browser, baseURL!);
    await check(page, 'new-org');
    await page.context().close();
  });

  // story #4453 — the same new person before verifying: the verify gate only (in sight), no recipe, no «시작»
  test('(나) not verified yet — the verify gate in front, nothing of the setup behind it', async ({ browser, baseURL }) => {
    const page = await newPersonPage(browser, baseURL!, { verified: false });
    await page.setViewportSize({ width: 1440, height: 900 - BAR });
    await page.goto(SETUP);
    const gate = page.getByTestId('email-verify-gate');
    await expect(gate).toBeVisible({ timeout: 60_000 });
    await expect(gate.getByRole('button', { name: '인증 메일 다시 보내기' })).toBeInViewport();
    await expect(page.locator('[aria-labelledby=setup-recipe]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '시작', exact: true })).toHaveCount(0);
    await page.context().close();
  });
});

/** The e-mail verification link's token, made the way the server makes it (backend app/core/security.py
 *  create_email_verification_token: HS256 · sub · type «email_verification» · 24 h) with the job's JWT_SECRET — so a test person
 *  verifies through the product's own /verify-email path, with no mailbox and no database write (story #4453). */
function verificationToken(userId: string, secret: string): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: userId, type: 'email_verification', iat: now, exp: now + 86_400 })}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

/** A person who has just signed up and has no organization: registered through the API, signed in through the web — and,
 *  unless `verified: false`, with the e-mail verified (story #4453: making an organization waits behind the verify gate). */
async function newPersonPage(browser: Browser, baseURL: string, { verified = true }: { verified?: boolean } = {}): Promise<Page> {
  const api = process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';
  const email = `e2e-4446-${Date.now()}-${Math.floor(Math.random() * 1e6)}@sprintable.test`;
  const password = `Pw-${Math.random().toString(36).slice(2)}-4446A!`;
  const context = await browser.newContext({ baseURL, locale: 'ko-KR' });
  const reg = await context.request.post(`${api}/api/v2/auth/register`, { data: { email, password, display_name: 'E2E 4446', tos_accepted: true } });
  expect(reg.status(), await reg.text()).toBeLessThan(300);
  const login = await context.request.post('/api/auth/login', { data: { email, password }, headers: { 'Content-Type': 'application/json', Origin: baseURL } });
  expect(login.ok(), await login.text()).toBe(true);
  if (verified) {
    const secret = process.env['JWT_SECRET'];
    expect(secret, 'JWT_SECRET (the job sets it for FastAPI and Next alike)').toBeTruthy();
    const me = await context.request.get('/api/auth/me');
    const userId = ((await me.json()) as { data?: { member_id?: string } }).data?.member_id;
    expect(userId, 'the signed-in person\'s id').toBeTruthy();
    const res = await context.request.post('/api/auth/verify-email', { data: { token: verificationToken(userId!, secret!) }, headers: { 'Content-Type': 'application/json', Origin: baseURL } });
    expect(res.ok(), await res.text()).toBe(true);
    const after = await context.request.get('/api/auth/me');
    expect(((await after.json()) as { data?: { email_verified?: boolean } }).data?.email_verified).toBe(true);
  }
  return context.newPage();
}
