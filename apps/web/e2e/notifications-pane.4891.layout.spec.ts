/**
 * story 4891 (UI-8 · settings › notifications) — the pane measured in Chromium on a phone: the real `NotificationsPane` (bundled with esbuild, not copied) and the real Tailwind build of globals.css; only the page's saves are a stand-in
 * (a switch flips, the level moves). Measured before the rebuild on dev (390 px): 9 of the pane's 10 controls under 44 px and 8 text spots under 12 px (smallest 11).
 * The rule under test, on a touch screen at 390: every press is ≥ 44 × 44, no visible text is under 12 px, every row is ≥ 56 high, nothing runs sideways; and at a phone width the two «coming soon» channel columns are not drawn (they are for a desktop width).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { compile, optimize } from '@tailwindcss/node';
import { layoutStubPlugin } from './support/layout-stubs';

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
        import React, { useState } from 'react'; import { createRoot } from 'react-dom/client'; import { NextIntlClientProvider } from 'next-intl';
        import ko from './messages/ko.json';
        import { NotificationsPane } from './src/app/(authenticated)/settings/notifications-pane';
        const CATEGORIES = [
          { key: 'story', types: ['story', 'story_assigned'] },
          { key: 'task', types: ['task', 'task_assigned', 'task_completed'] },
          { key: 'sprint', types: ['sprint_closed'] },
          { key: 'system', types: ['info', 'warning', 'system', 'standup_reminder', 'reward', 'invitation'] },
        ];
        function Harness() {
          const [level, setLevel] = useState('all'); const [off, setOff] = useState({});
          const enabled = (e) => !off[e];
          return React.createElement(NotificationsPane, {
            loading: false, categories: CATEGORIES, globalLevel: level, savingLevel: false, onSetLevel: setLevel,
            getEnabled: enabled, onToggle: (e, cur) => setOff({ ...off, [e]: cur }),
            isCategoryAllEnabled: (k) => CATEGORIES.find((c) => c.key === k).types.every(enabled),
            onToggleCategory: (k, enable) => { const n = { ...off }; CATEGORIES.find((c) => c.key === k).types.forEach((t) => { n[t] = !enable; }); setOff(n); },
            showSoonColumns: true,
          });
        }
        window.__mount = () => {
          createRoot(document.getElementById('root')).render(React.createElement(NextIntlClientProvider, { locale: 'ko', messages: ko, timeZone: 'Asia/Seoul' }, React.createElement(Harness)));
        };`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_APP_URL': '"https://app.sprintable.ai"' },
    plugins: [layoutStubPlugin()],
  });
  const js = out.outputFiles[0]!.text;
  const candidates = [...new Set([...js.matchAll(/"([^"\n]+)"/g)].flatMap((m) => m[1]!.split(/\s+/)).filter(Boolean))];
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  const css = (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(candidates), { minify: false }).code;
  built = { js, css };
  return built;
}

async function open(page: Page, width: number) {
  const { js, css } = await build();
  await page.setViewportSize({ width, height: 844 });
  await page.unrouteAll();
  await page.route('http://preview.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-background text-foreground"><div id="root" style="padding:16px"></div></body></html>` });
    }
    return route.fulfill({ status: 404, body: '{}' });
  });
  await page.goto('about:blank');
  await page.goto('http://preview.test/');
  await page.addScriptTag({ content: js });
  await page.evaluate(() => (window as unknown as { __mount: () => void }).__mount());
  await page.getByTestId('notifications-pane').waitFor();
}

/** what a thumb meets: the visible presses and text, as the browser lays them out */
const measure = (page: Page) => page.evaluate(() => {
  const vis = (e: Element) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const presses = [...document.querySelectorAll('button, [role=switch], a[href], input, select, summary')].filter(vis);
  const small = presses.filter((e) => { const r = e.getBoundingClientRect(); return r.width < 43.5 || r.height < 43.5; }).map((e) => `${(e.getAttribute('aria-label') || e.textContent || e.tagName).trim().slice(0, 18)} ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`);
  const leaves = [...document.querySelectorAll('body *')].filter((e) => e.children.length === 0 && (e.textContent || '').trim() && vis(e));
  const tiny = leaves.filter((e) => parseFloat(getComputedStyle(e).fontSize) < 12).map((e) => `${(e.textContent || '').trim().slice(0, 14)} ${getComputedStyle(e).fontSize}`);
  const rows = [...document.querySelectorAll('[data-slot="ds-list-row"]')].filter(vis).map((e) => Math.round(e.getBoundingClientRect().height));
  const soon = [...document.querySelectorAll('span')].filter((e) => /준비 중/.test(e.textContent || '') && vis(e)).length;
  return { presses: presses.length, small, tiny, rowMin: rows.length ? Math.min(...rows) : 0, rows: rows.length, overflowX: document.documentElement.scrollWidth > innerWidth + 1, soon };
});

test.describe('on a phone (390 px · touch)', () => {
  test.use({ hasTouch: true, isMobile: true });

  test('[SID:4891] every press is at least 44 × 44, no text is under 12 px, every row is at least 56 high, nothing runs sideways', async ({ page }) => {
    await open(page, 390);
    const m = await measure(page);
    expect(m.presses, 'the pane has its presses (3 levels + 4 category buttons + 12 switches)').toBeGreaterThanOrEqual(19);
    expect(m.small, `presses under 44 px: ${m.small.join(' · ')}`).toEqual([]);
    expect(m.tiny, `text under 12 px: ${m.tiny.join(' · ')}`).toEqual([]);
    expect(m.rows).toBe(12);
    expect(m.rowMin, 'the smallest row').toBeGreaterThanOrEqual(56);
    expect(m.overflowX, 'the page runs sideways').toBe(false);
  });

  test('[SID:4891] the two «coming soon» channel columns are not drawn at a phone width', async ({ page }) => {
    await open(page, 390);
    expect((await measure(page)).soon).toBe(0);
  });

  test('[SID:4891] pressing a switch flips it, a category button flips the whole category, a level button moves the choice', async ({ page }) => {
    await open(page, 390);
    const first = page.getByRole('switch').first();
    await expect(first).toHaveAttribute('aria-checked', 'true');
    await first.tap();
    await expect(first).toHaveAttribute('aria-checked', 'false');
    const level = page.getByRole('button', { name: '멘션만' });
    await level.tap();
    await expect(level).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('notifications-category-task').getByRole('button', { name: '전체 끄기' }).tap();
    for (const sw of await page.getByTestId('notifications-category-task').getByRole('switch').all()) await expect(sw).toHaveAttribute('aria-checked', 'false');
  });
});

test('[SID:4891] on a desktop width the «coming soon» columns are drawn', async ({ page }) => {
  await open(page, 1440);
  expect((await measure(page)).soon).toBeGreaterThan(0);
});
