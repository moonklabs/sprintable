/**
 * story 4946 (the desktop app's room) — in a SHORT window (under 600 px high) the room head folds its chip row into a «people N» button + popover (the shared RoomPeoplePopover): the head gets lower, the people are one press away,
 * nothing is lost. Above 600 px the head is the row of chips as before. The REAL RoomHead + the real Tailwind in Chromium: the media query is the viewport's own height (1100 wide; 539 · 599 · 600 · 601 · 647 · 900 high).
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

let built: { js: string; css: string } | null = null;
async function build() {
  if (built) return built;
  const esbuild = req('esbuild') as typeof import('esbuild');
  const out = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react'; import { createRoot } from 'react-dom/client';
        import { RoomHead } from './src/components/chat/room-head';
        const CHIPS = [{ id: 'm1', who: 'Lap4946 Dan(나)' }, { id: 'm2', who: 'Claude Code', state: 'connected' }, { id: 'm3', who: '디자인 에이전트' }];
        window.__fold = true;
        window.__added = 0;
        window.__mount = () => {
          createRoot(document.getElementById('root')).render(React.createElement('div', { id: 'frame', className: 'bg-ds-background', style: { width: 1100 } },
            React.createElement(RoomHead, { title: '런치 주간 조율', tag: '프로젝트 방', subline: 'Launch week · 3명', chips: CHIPS, moreCount: 0, addLabel: '참여자 추가', onAdd: () => { window.__added += 1; }, trailing: React.createElement('span', null, '⋯'),
              ...(window.__fold ? { peopleLabel: '참여자 보기', peopleCount: 3 } : {}) })));
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

async function open(page: Page, height: number, fold = true) {
  const { js, css } = await build();
  await page.setViewportSize({ width: 1100, height });
  await page.unrouteAll();
  await page.route('http://preview.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body style="margin:0"><div id="root"></div></body></html>` });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [] }) });
  });
  await page.goto('about:blank'); await page.goto('http://preview.test/');
  await page.addScriptTag({ content: js });
  await page.evaluate((f) => { (window as unknown as { __fold: boolean }).__fold = f; }, fold); // after the bundle (it sets the default), before the mount
  await page.evaluate(() => (window as unknown as { __mount: () => void }).__mount());
  await page.getByTestId('room-head').waitFor();
}

const geometry = (page: Page) => page.evaluate(() => {
  const head = document.querySelector('[data-testid="room-head"]') as HTMLElement;
  const ul = head.querySelector(':scope > ul[data-testid="room-head-chips"]') as HTMLElement | null;
  const btn = head.querySelector('[data-testid="room-bar-people"]') as HTMLElement | null;
  const r = (e: Element | null) => (e ? Math.round(e.getBoundingClientRect().height) : null);
  return { headH: Math.round(head.getBoundingClientRect().height), ulDisplay: ul ? getComputedStyle(ul).display : 'none', ulH: r(ul), chipLists: head.querySelectorAll('[data-testid="room-head-chips"]').length, peopleButtons: head.querySelectorAll('[data-testid="room-bar-people"]').length, btnW: btn ? Math.round(btn.getBoundingClientRect().width) : null, btnH: r(btn), btnDisplay: btn ? getComputedStyle(btn).display : null, btnName: btn ? (btn.textContent ?? '').trim() : null };
});

test.describe('the room head folds its chips in a short window (story 4946)', () => {
  test('[SID:4946] ⭐539 high (the Mac app\'s small window): the chip row is gone, a «people 3» button is there, the head is LOWER (3 rows → 2)', async ({ page }) => {
    await open(page, 539);
    const g = await geometry(page);
    expect(g.ulDisplay).toBe('none'); expect(g.chipLists, 'the chips are in the popup only once it is open').toBe(0); expect(g.peopleButtons).toBe(1);
    expect(g.btnDisplay).not.toBeNull(); expect(g.btnW).toBeGreaterThan(30); expect(g.btnH).toBeGreaterThanOrEqual(28);
    expect(g.btnName).toContain('3');
    expect(g.headH, 'the folded head is the kit minimum (80) and no taller').toBeLessThanOrEqual(80); // story 5031 (C1 2b): min-h-20
  });
  test('[SID:4946] ⭐647 · 900 high: the chip row is drawn as before and the people button is not (the head is the 3-row one)', async ({ page }) => {
    for (const h of [647, 900]) {
      await open(page, h);
      const g = await geometry(page);
      expect(g.ulDisplay, `${h}`).not.toBe('none'); expect(g.ulH, `${h}`).toBeGreaterThan(20);
      expect(g.btnDisplay, `${h}`).toBeNull(); expect(g.peopleButtons, `${h}`).toBe(0); // not drawn at all (no hidden copy)
      expect(g.headH, `${h}`).toBeGreaterThan(95);
    }
  });
  test('[SID:4946] the threshold is exact: 600 high is folded, 601 is not', async ({ page }) => {
    await open(page, 600); expect((await geometry(page)).ulDisplay).toBe('none');
    await open(page, 601); expect((await geometry(page)).ulDisplay).not.toBe('none');
  });
  test('[SID:4946] ⭐nothing is lost when folded: the button opens the people (all three chips) and the «+» (add a participant) works from it', async ({ page }) => {
    await open(page, 539);
    await page.locator('[data-testid="room-head"] [data-testid="room-bar-people"]').click();
    const popup = page.getByTestId('room-bar-people-popup');
    await expect(popup).toBeVisible();
    await expect(popup.getByTestId('room-head-chip')).toHaveCount(3);
    await expect(popup.getByTestId('room-head-add')).toBeVisible();
    await popup.getByTestId('room-head-add').click();
    expect(await page.evaluate(() => (window as unknown as { __added: number }).__added)).toBe(1);
  });
  test('[SID:4946] a head given no people count (a caller that has not opted in) never folds: the chips stay at 539 high too', async ({ page }) => {
    await open(page, 539, false);
    const g = await geometry(page);
    expect(g.ulDisplay).not.toBe('none'); expect(g.btnDisplay).toBeNull();
  });
});
