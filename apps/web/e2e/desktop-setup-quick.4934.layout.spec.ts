/**
 * story 4934 — the first-run agent card (/desktop/setup · DesktopSetupQuick): the free plan's «one project» question and its button «넣고 만들기» (or «만들기») are
 * IN SIGHT the moment a folder is picked, in the app's own web area (1440 × 900 window → the web is 539 px high; 1100 wide is the Mac app's default), with nothing
 * scrolled — in both of the card's real parents: the window scrolls · an inner area scrolls (the app shell). Before: the button sat below the fold (y 545 «만들기» ·
 * y 634 «넣고 만들기»), so the first press looked like nothing happened (민 4906 lap 3 · PO verdict).
 * Measured in Chromium with the REAL DesktopSetupQuick (bundled with esbuild, not copied), the real Tailwind build and the real korean words; the plan's answer is
 * GET /api/desktop/recipes `project_room` (a routed reply), the same read the card makes in the app.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { compile, optimize } from '@tailwindcss/node';
import { layoutStubPlugin } from './support/layout-stubs';
import { tailwindCandidates } from './support/tailwind-candidates';

const req = createRequire(__filename);
const WEB = path.join(__dirname, '..');
const APP = path.join(WEB, 'src', 'app');
const PROJ = '11111111-1111-4111-8111-111111111111';
const CODE = `${'A'.repeat(20)}_-${'b'.repeat(21)}`;
const HASH = `#code=${CODE}&setup=11111111-1111-4111-8111-aaaaaaaaaaaa&runtimes=claude,codex&caps=move,solo&rv=claude:2.1.289,codex:0.159.3&fshown=~/new/folder&fname=folder`;

let built: { js: string; css: string } | null = null;
async function build() {
  if (built) return built;
  const esbuild = req('esbuild') as typeof import('esbuild');
  const out = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react'; import { createRoot } from 'react-dom/client'; import { NextIntlClientProvider } from 'next-intl';
        import ko from './messages/ko.json';
        import { DesktopSetupQuick } from './src/components/desktop/desktop-setup-quick';
        import { parseSetupFragment } from './src/lib/desktop-setup';
        window.__mount = (hash, inner) => {
          const card = React.createElement(NextIntlClientProvider, { locale: 'ko', messages: ko, timeZone: 'Asia/Seoul' },
            React.createElement(DesktopSetupQuick, { query: parseSetupFragment(hash), onTeam: () => {} }));
          // the card sits in the parents the app really has: the page's own padding (the card is p-6 inside a padded main) · an inner scroller when asked
          const page = React.createElement('div', { style: { padding: '24px', maxWidth: '640px', margin: '0 auto' } }, card);
          const tree = inner ? React.createElement('div', { id: 'scroller', style: { height: '100vh', overflowY: 'auto' } }, page) : page;
          createRoot(document.getElementById('root')).render(tree);
        };`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_APP_URL': '"https://app.sprintable.ai"' },
    plugins: [layoutStubPlugin()],
  });
  const js = out.outputFiles[0]!.text;
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  const css = (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(tailwindCandidates(js)), { minify: false }).code;
  built = { js, css };
  return built;
}

async function open(page: Page, win: { w: number; h: number }, o: { inner: boolean; room: boolean; phoneRowOff?: boolean }) {
  const { js, css } = await build();
  await page.setViewportSize({ width: win.w, height: win.h });
  await page.unrouteAll();
  await page.route('http://preview.test/**', async (route) => {
    const url = new URL(route.request().url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>` });
    if (url.pathname === '/api/desktop/recipes') return json({ recipes: [], agent_room: null, project_room: o.room ? { limit: 1, existing_project: { id: PROJ, name: 'Mine' } } : null });
    if (/^\/api\/organizations\/[^/]+\/remote-control$/.test(url.pathname)) return json({ data: { enabled: !o.phoneRowOff, can_change: true, enabled_at: null } });
    return json({}, 404);
  });
  await page.addInitScript(() => {
    (window as unknown as { process: unknown }).process = { env: {} };
    (window as unknown as { __dashboardCtx: unknown }).__dashboardCtx = {
      orgId: 'org-1', projectId: '11111111-1111-4111-8111-111111111111', userName: '김지우',
      orgMemberships: [{ orgId: 'org-1', orgName: 'O', orgSlug: 'o', role: 'owner' }],
      projectMemberships: [{ projectId: '11111111-1111-4111-8111-111111111111', projectName: 'Mine', orgId: 'org-1' }],
    };
  });
  await page.goto('about:blank');
  await page.goto('http://preview.test/');
  await page.addScriptTag({ content: js });
  await page.evaluate(([h, inner]) => (window as unknown as { __mount: (h: string, i: boolean) => void }).__mount(h as string, inner as boolean), [HASH, o.inner] as const);
  await page.locator('[data-testid="quick-start-row"]').waitFor({ timeout: 20_000 });
  if (o.room) await page.locator('[data-testid="quick-limit"]').waitFor({ timeout: 20_000 }); // the plan's answer has come and the question is drawn
  await page.waitForTimeout(300);
}

/** where the start row's button and the question are against the visible part of whatever scrolls (nothing scrolled) */
const sight = (page: Page, label: string) => page.evaluate((lab) => {
  const b = [...document.querySelectorAll('[data-testid="quick-start-row"] button')].find((x) => (x.textContent || '').trim() === lab) as HTMLElement | undefined;
  if (!b) return { found: false } as const;
  const sc = document.getElementById('scroller');
  const view = sc ? sc.getBoundingClientRect() : { top: 0, bottom: innerHeight };
  const bottom = Math.min(view.bottom, innerHeight);
  const r = b.getBoundingClientRect();
  const box = document.querySelector('[data-testid="quick-limit"]')?.getBoundingClientRect();
  const row = document.querySelector('[data-testid="quick-start-row"]')!.getBoundingClientRect();
  return {
    found: true as const, inSight: r.top >= view.top && r.bottom <= bottom, top: Math.round(r.top), bottom: Math.round(r.bottom), viewBottom: Math.round(bottom),
    boxInSight: box ? box.top >= view.top && box.bottom <= bottom : null, rowTopInSight: row.top >= view.top, scrolled: sc ? sc.scrollTop : scrollY,
    overflowX: document.documentElement.scrollWidth > innerWidth + 1,
    tall: (sc ? sc.scrollHeight : document.documentElement.scrollHeight) > (bottom - view.top) + 40, // the card really is taller than the window (else the test proves nothing)
  };
}, label);

const WINDOWS = [{ w: 1440, h: 539 }, { w: 1100, h: 539 }, { w: 1440, h: 900 }];
for (const win of WINDOWS) {
  for (const inner of [false, true]) {
    const where = `${win.w}×${win.h} · ${inner ? 'inner area scrolls' : 'window scrolls'}`;
    test.describe(`4934 start row in sight · ${where}`, () => {
      test('the plan has no room for a new project: the question and «넣고 만들기» are in sight, nothing scrolled', async ({ page }) => {
        await open(page, win, { inner, room: true });
        const s = await sight(page, '넣고 만들기');
        expect(s.found, `${where}: «넣고 만들기» drawn`).toBe(true);
        expect(s, `${where}: the button is in sight`).toMatchObject({ found: true, inSight: true, scrolled: 0, overflowX: false });
        expect((s as { boxInSight: boolean | null }).boxInSight, `${where}: the question is in sight with it`).toBe(true);
        if (win.h === 539) expect((s as { tall: boolean }).tall, `${where}: the card is taller than the window (the guard has something to hold)`).toBe(true);
      });

      test('room left: «만들기» in sight, nothing scrolled', async ({ page }) => {
        await open(page, win, { inner, room: false });
        const s = await sight(page, '만들기');
        expect(s, `${where}: «만들기» in sight`).toMatchObject({ found: true, inSight: true, scrolled: 0, overflowX: false });
      });

      test('with the «폰으로도 에이전트 다루기» tick drawn too (remote control off): the button and the question stay in sight', async ({ page }) => {
        await open(page, win, { inner, room: true, phoneRowOff: true });
        await expect(page.locator('[data-testid="setup-phone-control"]')).toBeVisible();
        const s = await sight(page, '넣고 만들기');
        expect(s, `${where}: with the phone tick`).toMatchObject({ found: true, inSight: true, scrolled: 0 });
        expect((s as { boxInSight: boolean | null }).boxInSight, `${where}: question in sight with the phone tick`).toBe(true);
      });
    });
  }
}

test('4934 the sticky row hides nothing for good: scrolled to the end, every step above it (the folder line too) is clear of the row', async ({ page }) => {
  await open(page, { w: 1440, h: 539 }, { inner: false, room: true });
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(200);
  const r = await page.evaluate(() => {
    const f = document.querySelector('[data-testid="quick-folder"]')!.getBoundingClientRect();
    const row = document.querySelector('[data-testid="quick-start-row"]')!.getBoundingClientRect();
    return { folderTop: f.top, folderBottom: f.bottom, rowTop: row.top, rowBottom: row.bottom, vh: innerHeight };
  });
  expect(r.folderBottom).toBeLessThanOrEqual(r.rowTop + 1); // above the row, not under it
  expect(r.rowBottom).toBeLessThanOrEqual(r.vh + 1); // and the row itself is whole
});
