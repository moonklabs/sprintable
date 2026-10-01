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

  test('the recipe list by keyboard (Yuna 02:56Z): ↓ only chooses, Enter folds with focus back on [바꾸기]; a mouse click folds', async ({ browser }) => {
    const context = await browser.newContext({ storageState: 'playwright/.auth/owner.json', locale: 'ko-KR', viewport: { width: 1440, height: 900 - BAR } });
    const page = await context.newPage();
    await openSetup(page);
    const change = page.getByTestId('setup-recipe-chosen').getByRole('button');
    await change.click();
    const list = page.getByTestId('setup-recipe-list');
    await expect(list).toBeVisible();
    await expect(page.locator('input[name=recipe]:checked')).toBeFocused();
    // [바꾸기] stays while open and says so; what it controls is there (Qadir 4869)
    await expect(change).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator(`#${await change.getAttribute('aria-controls')}`)).toBeVisible();
    const order = await list.locator('input[name=recipe]').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(list, 'arrows only choose — the list stays open').toBeVisible();
    expect(await list.locator('input[name=recipe]').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value)), 'not re-sorted under the keyboard').toEqual(order);
    await expect(list.locator('input[name=recipe]').nth(2)).toBeChecked();
    await page.keyboard.press('Enter');
    await expect(list).toHaveCount(0);
    await expect(page.getByTestId('setup-recipe-chosen').getByRole('button')).toBeFocused();
    // a person's mouse click on a card chooses and folds
    await page.getByTestId('setup-recipe-chosen').getByRole('button').click();
    await list.locator('label').nth(1).click();
    await expect(list).toHaveCount(0);
    // [바꾸기] again folds it (a disclosure button toggles)
    await change.click();
    await expect(list).toBeVisible();
    await change.click();
    await expect(list).toHaveCount(0);
    await expect(change).toHaveAttribute('aria-expanded', 'false');
    await context.close();
  });

  test('(나) a new organization — a person with none yet (the window scrolls)', async ({ browser, baseURL }) => {
    const page = await newPersonPage(browser, baseURL!);
    await check(page, 'new-org');
    await page.context().close();
  });
});

/** A person who has just signed up and has no organization: registered through the API, signed in through the web. */
async function newPersonPage(browser: Browser, baseURL: string): Promise<Page> {
  const api = process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';
  const email = `e2e-4446-${Date.now()}-${Math.floor(Math.random() * 1e6)}@sprintable.test`;
  const password = `Pw-${Math.random().toString(36).slice(2)}-4446A!`;
  const context = await browser.newContext({ baseURL, locale: 'ko-KR' });
  const reg = await context.request.post(`${api}/api/v2/auth/register`, { data: { email, password, display_name: 'E2E 4446', tos_accepted: true } });
  expect(reg.status(), await reg.text()).toBeLessThan(300);
  const login = await context.request.post('/api/auth/login', { data: { email, password }, headers: { 'Content-Type': 'application/json', Origin: baseURL } });
  expect(login.ok(), await login.text()).toBe(true);
  return context.newPage();
}
