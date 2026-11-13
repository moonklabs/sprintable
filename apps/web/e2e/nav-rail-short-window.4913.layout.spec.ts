/**
 * story 4913 (shell follow-up) — the icon rail on a SHORT window, measured in Chromium on the REAL NavRail (bundled with esbuild, not copied): with the real account icon, the real Button borders and unread / count badges.
 * Before: the rail is pinned to the window height (h-svh) and its eleven icons (40 px cells + 4 px gaps ≈ 494 px) overflowed a 420 px window by 74 px, so the whole document scrolled (dev 1100×420).
 * Rules: the document does not scroll · every rail icon is inside the window · a count badge never covers its own icon · on a tall window nothing changed (40 px cells).
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';
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
        import React from 'react'; import { createRoot } from 'react-dom/client'; import { NextIntlClientProvider } from 'next-intl';
        import ko from './messages/ko.json';
        import { NavRail } from './src/components/nav/nav-rail';
        window.__mount = () => createRoot(document.getElementById('root')).render(React.createElement(NextIntlClientProvider, { locale: 'ko', messages: ko, timeZone: 'Asia/Seoul' },
          React.createElement('div', { style: { display: 'flex', height: '100svh' } },
            React.createElement(NavRail, { orgSlug: 'o', projectSlug: 'p', account: { orgMemberships: [], projectMemberships: [], userName: 'Q' }, listColumn: { open: true, onToggle() {} }, todayCount: 3, chatUnreadTotal: 12, onOpenPalette() {} }),
            React.createElement('main', { style: { flex: 1 } }, 'main'))));`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_APP_URL': '"https://dev-app.sprintable.ai"' },
    plugins: [{
      name: 'nav-stub',
      setup(b: import('esbuild').PluginBuild) {
        b.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: 'next-navigation-stub', namespace: 'nav-stub' }));
        b.onLoad({ filter: /.*/, namespace: 'nav-stub' }, () => ({
          contents: "export const useSearchParams = () => new URLSearchParams(); export const useParams = () => ({}); export const usePathname = () => '/inbox'; export const useRouter = () => ({ replace() {}, push() {}, back() {}, refresh() {} });",
          loader: 'js',
        }));
      },
    }, layoutStubPlugin()],
  });
  const js = out.outputFiles[0]!.text;
  const candidates = [...new Set([...js.matchAll(/"([^"\n]+)"/g)].flatMap((m) => m[1]!.split(/\s+/)).filter(Boolean))];
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  const css = (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(candidates), { minify: false }).code;
  built = { js, css };
  return built;
}

for (const [width, height] of [[1100, 420], [1280, 480], [1440, 520], [1440, 900]] as const) {
  test(`[SID:4913] rail ${width}×${height}: the document does not scroll, every icon is inside the window, a badge does not cover its icon`, async ({ page }) => {
    const { js, css } = await build();
    await page.setViewportSize({ width, height });
    await page.setContent(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>html,body{margin:0}${css}</style></head><body><div id="root"></div></body></html>`);
    await page.addInitScript(() => { (window as unknown as { process: unknown }).process = { env: {} }; });
    await page.addScriptTag({ content: 'window.process = { env: {} };' });
    await page.addScriptTag({ content: js });
    await page.evaluate(() => (window as unknown as { __mount: () => void }).__mount());
    await page.locator('[data-testid="nav-rail"]').waitFor();
    const m = await page.evaluate(() => {
      const rail = document.querySelector('[data-testid="nav-rail"]')!;
      const items = [...rail.querySelectorAll('a[href], button')].filter((e) => !e.closest('[data-testid^="rail-"][data-testid$="-panel"]')).map((e) => ({ r: e.getBoundingClientRect(), label: e.getAttribute('aria-label') || '' })).filter((i) => i.r.width > 0 && i.r.height > 0); // visible ones only (a daily group's flyout links are `hidden` until opened)
      const cells = [...rail.querySelectorAll('a[href] > span[class*="justify-center"], button > span[class*="justify-center"]')].map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
      const badges = [...rail.querySelectorAll('[data-testid="rail-badge"]')].map((b) => {
        const br = b.getBoundingClientRect();
        const icon = b.parentElement!.querySelector('svg, [class*="material"], span > span, span')!.getBoundingClientRect();
        const glyph = (b.parentElement!.querySelector('span') as HTMLElement).firstElementChild?.getBoundingClientRect() ?? icon;
        const overlap = Math.min(br.right, glyph.right) - Math.max(br.left, glyph.left) > 1 && Math.min(br.bottom, glyph.bottom) - Math.max(br.top, glyph.top) > 1;
        return { top: br.top, overlap };
      });
      const sorted = items.map((i) => i.r).sort((a, b) => a.top - b.top);
      const gaps = sorted.slice(1).map((r, i) => Math.round(r.top - sorted[i]!.bottom)).filter((g) => g > 0 && g < 10); // neighbours only (0 = an item inside another · the wider gap is the mt-auto push between the two groups)
      return { gaps, cellWs: [...new Set(cells.map((c) => `${Math.round(c.width)}x${Math.round(c.height)}`))], docOver: document.documentElement.scrollHeight - window.innerHeight, lastBottom: Math.max(...items.map((i) => i.r.bottom)), firstTop: Math.min(...items.map((i) => i.r.top)), count: items.length, cellW: Math.round(cells[0]!.width), badges };
    });
    expect(m.count, 'the whole rail is there: 4 daily groups + chat + org + list column + account + search + settings + all screens').toBeGreaterThanOrEqual(11);
    expect(m.docOver, 'the document does not scroll').toBeLessThanOrEqual(0);
    expect(m.lastBottom, 'the last icon is inside the window').toBeLessThanOrEqual(height);
    expect(m.badges.length, 'the count badges are drawn (today + chat)').toBeGreaterThanOrEqual(2);
    for (const b of m.badges) {
      expect(b.overlap, 'a count badge does not cover its icon').toBe(false);
      expect(b.top, 'a count badge is not cut off at the top of the window').toBeGreaterThanOrEqual(0);
    }
    // EVERY icon cell (the account icon and the three Button-based ones included), not just the first
    expect(m.cellWs, height <= 520 ? 'short window: every cell is 32 px' : 'tall window: every cell keeps the full 40 px').toEqual([height <= 520 ? '32x32' : '40x40']);
    // the gap between neighbours (top group and bottom group both)
    expect(Math.min(...m.gaps), height <= 520 ? 'short window: 2 px gaps between icons' : 'tall window: 4 px gaps between icons').toBe(height <= 520 ? 2 : 4);
    expect(Math.max(...m.gaps.filter((g) => g < 8)), 'no icon pair is spaced wider than the rule').toBeLessThanOrEqual(height <= 520 ? 2 : 4);
  });
}
