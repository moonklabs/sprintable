/**
 * story 5035 (C5) — the agents' place as ONE frame, measured in Chromium with the REAL `WorkforceFrame` (+ the real ds `ListDetailShell`, the real `AgentManagementTab` rows in the list column, the real `TabNav` strip) built with esbuild and the real Tailwind build.
 * Only the address (next/navigation) and the server answers (`fetch`) are made here. No server and no sign-in.
 * Rules (the six states of the plan's closing rule that a layout can say: default · long text · 390 · 1440; loading / empty / error are the list's own states, pinned by agent-management-tab tests):
 *   · 1440: the list is a 360–420 column on the LEFT and the detail sits BESIDE it (same top), nothing scrolls sideways, the detail scrolls inside its own column.
 *   · 390: the list alone (no detail column); with an agent in the address the detail is a sheet that fits the window.
 *   · a very long agent name does not push a row wider than the list column (a row used to be drawn on a 720 «reading» page; the column is 360–420).
 *   · the «전체 보기» strip fits a phone without a sideways page scroll.
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

const LONG_NAME = 'a-very-long-agent-name-that-keeps-going-and-going-without-a-single-space-to-break-on-0123456789-abcdefghijklmnopqrstuvwxyz';
const AGENTS = [
  { id: 'a1', name: '댄 어윈', role: 'engineer', is_active: true, verified: true, client_version: '2.1.0', plugin_version: '0.2.135', session_started_at: new Date(Date.now() - 3600_000).toISOString(), device_name: 'SYJ-MacBook-Pro' },
  { id: 'a2', name: LONG_NAME, role: 'product-owner', is_active: false, verified: false, needs_restart: true, run_model_unset: true, device_name: 'a-computer-with-a-rather-long-device-name-too' },
  { id: 'a3', name: '민', role: 'engineer', is_active: true, verified: true },
];

let built: { js: string; css: string } | null = null;
async function build() {
  if (built) return built;
  const esbuild = req('esbuild') as typeof import('esbuild');
  const navPlugin = {
    name: 'wf-nav',
    setup(b: import('esbuild').PluginBuild) {
      b.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: 'next-navigation', namespace: 'wf-nav' }));
      b.onLoad({ filter: /.*/, namespace: 'wf-nav' }, () => ({
        loader: 'js',
        contents: `export const usePathname = () => window.__path;
          export const useSearchParams = () => new URLSearchParams(window.__search || '');
          export const useRouter = () => ({ push: (h) => { window.__pushed = h; }, replace() {}, back() {}, prefetch() {} });`,
      }));
    },
  };
  const out = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react'; import { createRoot } from 'react-dom/client';
        import { NextIntlClientProvider } from 'next-intl';
        import messages from './messages/ko.json';
        import { TopBarProvider } from './src/components/nav/top-bar-context';
        import { WorkforceFrame } from './src/components/agents/workforce-frame';
        window.__mount = () => createRoot(document.getElementById('root')).render(
          React.createElement(NextIntlClientProvider, { locale: 'ko', messages, timeZone: 'Asia/Seoul' },
            React.createElement(TopBarProvider, null, // the frame mounts the top bar's title itself on a phone list (codex 5939)
              React.createElement(WorkforceFrame, null,
                React.createElement('div', { 'data-testid': 'detail-probe', style: { height: 2400, background: 'transparent' } }, 'detail probe')))));`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'), define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [navPlugin, layoutStubPlugin()],
  });
  const js = out.outputFiles[0]!.text;
  const candidates = tailwindCandidates(js);
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  const css = (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(candidates), { minify: false }).code;
  built = { js, css };
  return built;
}

async function open(page: Page, o: { viewport: [number, number]; path: string; search?: string }) {
  const { js, css } = await build();
  await page.setViewportSize({ width: o.viewport[0], height: o.viewport[1] });
  await page.route('http://preview.test/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>${css}</style></head><body class="bg-ds-background text-ds-ink"><div id="root"></div></body></html>`,
  }));
  // the server answers the list reads (real fetch calls of the real list)
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    const json = (data: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
    if (url.pathname === '/api/me' || url.pathname.endsWith('/me')) return json({ role: 'owner' });
    if (url.pathname === '/api/team-members') return json(AGENTS);
    if (url.pathname === '/api/projects') return json([{ id: 'p1', name: 'Sprintable' }]);
    if (url.pathname.startsWith('/api/projects/')) return json([{ member_id: 'a1' }, { member_id: 'a3' }]);
    return json([]);
  });
  await page.goto('http://preview.test/');
  const thrown: string[] = [];
  page.on('pageerror', (e) => thrown.push(e.message));
  await page.evaluate(({ p, s }) => { (window as unknown as { __path: string; __search: string }).__path = p; (window as unknown as { __search: string }).__search = s; }, { p: o.path, s: o.search ?? '' });
  await page.addScriptTag({ content: js });
  await page.evaluate(() => (window as unknown as { __mount: () => void }).__mount());
  await page.locator('[data-testid="workforce-frame"], [data-testid="workforce-all-views-band"]').first().waitFor();
  await page.waitForTimeout(400); // the list reads settle
  expect(thrown, 'no page error').toEqual([]);
}

const rect = (page: Page, sel: string) => page.evaluate((s) => {
  const el = document.querySelector(s) as HTMLElement | null;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height), scrollW: el.scrollWidth, clientW: el.clientWidth };
}, sel);
const pageOverflowX = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test('[SID:5035] 1440: the list is a 360–420 column on the left and the detail sits BESIDE it (same top) · nothing scrolls sideways', async ({ page }) => {
  await open(page, { viewport: [1440, 900], path: '/organization/workforce/a1' });
  const list = (await rect(page, '[data-testid="workforce-list-column"]'))!;
  const detail = (await rect(page, '[data-testid="workforce-detail-column"]'))!;
  expect(list.width, `list ${list.width}`).toBeGreaterThanOrEqual(360);
  expect(list.width, `list ${list.width}`).toBeLessThanOrEqual(420);
  expect(detail.left, 'detail is right of the list').toBeGreaterThanOrEqual(list.right);
  expect(Math.abs(detail.top - list.top), 'same top').toBeLessThanOrEqual(2);
  expect(await pageOverflowX(page)).toBeLessThanOrEqual(0);
});

test('[SID:5035] 1440: a tall detail scrolls INSIDE its column (the column stays inside the window)', async ({ page }) => {
  await open(page, { viewport: [1440, 700], path: '/organization/workforce/a1' });
  const col = (await rect(page, '[data-testid="workforce-detail-column"]'))!;
  expect(col.height, `column ${col.height}`).toBeLessThanOrEqual(700);
  const inner = await page.evaluate(() => {
    const probe = document.querySelector('[data-testid="detail-probe"]') as HTMLElement;
    const scroller = probe.parentElement as HTMLElement;
    return { overflowY: getComputedStyle(scroller).overflowY, scrolls: scroller.scrollHeight > scroller.clientHeight };
  });
  expect(inner.overflowY).toBe('auto');
  expect(inner.scrolls).toBe(true);
});

test('[SID:5035] 1440 long text: a very long agent name and device name do not push a row wider than the list column', async ({ page }) => {
  await open(page, { viewport: [1440, 900], path: '/organization/workforce' });
  const over = await page.evaluate(() => {
    const col = document.querySelector('[data-testid="workforce-list-column"]') as HTMLElement;
    const colR = col.getBoundingClientRect();
    const rows = Array.from(col.querySelectorAll('[data-testid^="agent-row-"]')).filter((el) => el.getAttribute('data-testid') !== 'agent-row-list') as HTMLElement[];
    return { rows: rows.length, colScroll: col.scrollWidth - col.clientWidth, widest: Math.max(...rows.map((r) => r.getBoundingClientRect().right - colR.right)) };
  });
  expect(over.rows, 'the three agents are drawn').toBe(3);
  expect(over.colScroll, 'the list column does not scroll sideways').toBeLessThanOrEqual(0);
  expect(over.widest, 'no row sticks out of the column').toBeLessThanOrEqual(1);
});

test('[SID:5035] 390: the list alone — no detail column, nothing scrolls sideways, no row is wider than the window', async ({ page }) => {
  await open(page, { viewport: [390, 800], path: '/organization/workforce' });
  expect(await rect(page, '[data-testid="workforce-detail-column"]')).toBeNull();
  expect(await pageOverflowX(page)).toBeLessThanOrEqual(0);
  const widest = await page.evaluate(() => Math.max(...Array.from(document.querySelectorAll('[data-testid^="agent-row-"]')).filter((el) => el.getAttribute('data-testid') !== 'agent-row-list').map((r) => r.getBoundingClientRect().right)));
  expect(widest).toBeLessThanOrEqual(390);
});

test('[SID:5035] 390 with an agent in the address: the detail is a sheet that fits the window', async ({ page }) => {
  await open(page, { viewport: [390, 800], path: '/organization/workforce/a1' });
  const sheet = (await rect(page, '[data-testid="workforce-detail-sheet"]'))!;
  expect(sheet, 'the sheet is open').not.toBeNull();
  expect(sheet.left).toBeGreaterThanOrEqual(0);
  expect(sheet.right).toBeLessThanOrEqual(390);
  expect(await page.locator('[data-testid="detail-probe"]').count()).toBe(1);
});

test('[SID:5035] 390 «전체 보기»: the strip fits a phone (it scrolls inside itself, the page does not)', async ({ page }) => {
  await open(page, { viewport: [390, 800], path: '/organization/workforce/runs' });
  const strip = (await rect(page, '[data-testid="workforce-all-views-strip"]'))!;
  expect(strip.right).toBeLessThanOrEqual(390);
  expect(await pageOverflowX(page)).toBeLessThanOrEqual(0);
  expect(await page.locator('[data-testid="workforce-all-views-strip"] a[data-all-view]').count()).toBe(5);
});

// story 5035 follow-up (PO's Two-Pass on 390): the «전체 보기» strip used to scroll sideways and was cut at «접근» with nothing saying there was more — now the links WRAP: every link is whole and one press away.
const linksAreWhole = (page: Page, scope: string) => page.evaluate((sel) => {
  const nav = document.querySelector(`${sel} nav`) as HTMLElement;
  const n = nav.getBoundingClientRect();
  const links = Array.from(nav.querySelectorAll('a[data-all-view]')) as HTMLElement[];
  return {
    count: links.length,
    clippedRight: Math.max(...links.map((l) => Math.round(l.getBoundingClientRect().right - n.right))),
    clippedLeft: Math.max(...links.map((l) => Math.round(n.left - l.getBoundingClientRect().left))),
    hiddenOverflow: nav.scrollWidth - nav.clientWidth,
    maskImage: getComputedStyle(nav).maskImage,
  };
}, scope);

test('[SID:5035] 390 list column: the five «전체 보기» links are all whole (they wrap — none is cut, nothing hides behind a side scroll)', async ({ page }) => {
  await open(page, { viewport: [390, 800], path: '/organization/workforce' });
  const r = await linksAreWhole(page, '[data-testid="workforce-all-views-menu"]');
  expect(r.count).toBe(5);
  expect(r.clippedRight, 'no link sticks out of the strip').toBeLessThanOrEqual(0);
  expect(r.clippedLeft).toBeLessThanOrEqual(0);
  expect(r.hiddenOverflow, 'nothing is hidden behind a sideways scroll').toBeLessThanOrEqual(0);
  expect(r.maskImage, 'no fade that makes a whole link look cut').toBe('none');
});

test('[SID:5035] 1440 list column (360–420): the five links are all whole too', async ({ page }) => {
  await open(page, { viewport: [1440, 900], path: '/organization/workforce' });
  const r = await linksAreWhole(page, '[data-testid="workforce-all-views-menu"]');
  expect(r.count).toBe(5);
  expect(r.clippedRight).toBeLessThanOrEqual(0);
  expect(r.hiddenOverflow).toBeLessThanOrEqual(0);
});

test('[SID:5035] 390 all-agents frame (back link + strip): the five links are all whole', async ({ page }) => {
  await open(page, { viewport: [390, 800], path: '/organization/workforce/runs' });
  const r = await linksAreWhole(page, '[data-testid="workforce-all-views-strip"]');
  expect(r.count).toBe(5);
  expect(r.clippedRight).toBeLessThanOrEqual(0);
  expect(r.hiddenOverflow).toBeLessThanOrEqual(0);
  expect(await pageOverflowX(page)).toBeLessThanOrEqual(0);
});

