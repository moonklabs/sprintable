/**
 * story 5031 (PR-B) — the attention queue's row keeps its ONE link over the whole row, measured in Chromium with the REAL `AttentionRow` (bundled with esbuild, not copied) and the real Tailwind build of globals.css; no server.
 *
 * The row is a ds `ListRow` whose title is a real `<a href>` stretched over the row by `after:absolute after:inset-0` (the whole row IS the link: a plain click goes through the app's router, ⌘-click / middle click stay the browser's).
 * Its `trailing` box (the actor's avatar · the verb «검토 ›») is NOT pressable by itself. The ds `ListRow`'s `trailing` box is `relative` (so a press at the right of a row — a status · «⋯» — can stand ABOVE such a stretched link, the agents rows on a phone):
 * a positioned box later in the order paints above the earlier `::after`, so without `pointer-events-none` on the trailing's non-pressable parts a click on the avatar or on the verb would hit THEM, not the link, and the row would stop navigating there.
 *
 * What is measured, at 390 and 1440: five points of the row, each asked with `document.elementFromPoint` — the title text · the avatar · the verb · the empty gap between the title column and the trailing box · the row's bottom padding — every one must answer as the row's link (or something in it);
 * and two real clicks (avatar · verb) must reach the link's own handler (`onNavigate` gets the row's href). A press that answers as something else is a press that does not navigate.
 * No text width is written anywhere here (a text's width differs Mac ↔ Linux).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import type { Plugin } from 'esbuild';
import { compile, optimize } from '@tailwindcss/node';
import { layoutStubPlugin } from './support/layout-stubs';
import { tailwindCandidates } from './support/tailwind-candidates';
import { shot } from './support/shell-scene';

const req = createRequire(__filename);
const WEB = path.join(__dirname, '..');
const APP = path.join(WEB, 'src', 'app');

const ROUTER_STUB = `
  export function usePathname() { return '/glance'; }
  export function useRouter() { return { push() {}, replace() {}, back() {}, refresh() {}, prefetch() {} }; }
  export function useSearchParams() { return new URLSearchParams(''); }
  export function useParams() { return {}; }`;
function routerPlugin(): Plugin {
  return { name: 'router-5031-attention', setup(b) {
    b.onResolve({ filter: /^next\/navigation$/ }, (a) => ({ path: a.path, namespace: 'router5031a' }));
    b.onLoad({ filter: /.*/, namespace: 'router5031a' }, () => ({ contents: ROUTER_STUB, loader: 'js', resolveDir: WEB }));
  } };
}

let built: { js: string; css: string } | null = null;
async function build() {
  if (built) return built;
  const esbuild = req('esbuild') as typeof import('esbuild');
  const out = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react'; import { createRoot } from 'react-dom/client'; import { NextIntlClientProvider } from 'next-intl';
        import ko from './messages/ko.json';
        import { AttentionRow } from './src/components/attention-queue/attention-queue-view';
        window.__mount = (cfg) => {
          window.__navigated = [];
          createRoot(document.getElementById('root')).render(
            <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
              <div id="frame" style={{ width: cfg.width + 'px' }} className="bg-ds-background">
                <div role="list">
                  <AttentionRow item={cfg.item} highlighted={false} onNavigate={(href) => window.__navigated.push(href)} />
                </div>
              </div>
            </NextIntlClientProvider>);
        };`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_APP_URL': '"https://app.sprintable.ai"', 'process.env.NEXT_PUBLIC_EE_ENABLED': '"false"' },
    plugins: [routerPlugin(), layoutStubPlugin()],
  });
  const js = out.outputFiles[0]!.text;
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  const css = (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(tailwindCandidates(js)), { minify: false }).code;
  built = { js, css };
  return built;
}

const ITEM = {
  id: 'a1', kind: 'gate_pending', bucket: 'now', kindLabel: '승인 대기', proofState: 'amber', claim: '결제 연동 검수 — 승인이 필요해요',
  actor: { name: '리뷰 에이전트', isAgent: true }, actionLabel: '검토', actionTone: 'primary', href: '/glance/stories/s1', enteredStateAtMs: 1_764_000_000_000, sortKey: 1,
};

async function open(page: Page, width: number) {
  const { js, css } = await build();
  await page.setViewportSize({ width, height: 700 });
  await page.unrouteAll();
  await page.route('http://preview.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-ds-background"><div id="root"></div></body></html>` });
    if (url.pathname.startsWith('/fonts/')) return route.fulfill({ path: path.join(WEB, 'public', 'fonts', path.basename(url.pathname)), contentType: 'font/woff2', headers: { 'access-control-allow-origin': '*' } });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"data":[]}' });
  });
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 300)));
  await page.goto('about:blank');
  await page.goto('http://preview.test/');
  await page.addScriptTag({ content: js });
  if (!(await page.evaluate(() => typeof (window as unknown as { __mount?: unknown }).__mount === 'function'))) throw new Error(`the bundle did not start: ${errs.join(' | ') || 'no page error'}`);
  await page.evaluate((c) => (window as unknown as { __mount: (c: unknown) => void }).__mount(c), { width, item: ITEM });
  await page.waitForSelector('[data-slot="ds-list-row"] a[href]', { state: 'attached', timeout: 8000 }).catch((e) => { throw new Error(`the row did not draw (page errors: ${errs.join(' | ') || 'none'})`, { cause: e }); });
  await page.evaluate(() => document.fonts.ready);
  // settle: the row's box holds still on two reads in a row (bounded polling, no fixed wait)
  let prev = '';
  await expect.poll(async () => {
    const sig = await page.evaluate(() => { const r = document.querySelector('[data-slot="ds-list-row"]')!.getBoundingClientRect(); return `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`; });
    const same = sig === prev; prev = sig; return same;
  }, { message: 'the row never held still', timeout: 8000, intervals: [100, 100, 200, 300] }).toBe(true);
  expect(errs, 'the page threw').toEqual([]);
}

/** the five points asked, as viewport coordinates (read from the DOM at the moment of asking) */
const probes = (page: Page) => page.evaluate((verb) => {
  const row = document.querySelector('[data-slot="ds-list-row"]') as HTMLElement;
  const link = row.querySelector('a[href]') as HTMLElement;
  const avatar = row.querySelector('[data-avatar]') as HTMLElement;
  const verbEl = [...row.querySelectorAll('span')].find((e) => e.children.length <= 1 && (e.textContent || '').trim() === verb) as HTMLElement;
  const trailing = verbEl.parentElement as HTMLElement; // the ds trailing box (the verb is its child, next to the avatar)
  const R = row.getBoundingClientRect(); const T = trailing.getBoundingClientRect();
  const c = (e: Element) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
  const text = link.getBoundingClientRect();
  return {
    link: { name: 'the title text', x: text.left + 8, y: text.top + text.height / 2 },
    avatar: { name: 'the avatar', ...c(avatar) },
    verb: { name: 'the verb «검토 ›»', ...c(verbEl) },
    gap: { name: 'the empty gap before the trailing box', x: T.left - 6, y: R.top + R.height / 2 },
    padding: { name: "the row's bottom padding", x: R.left + R.width / 2, y: R.bottom - 3 },
  };
}, ITEM.actionLabel);

async function answers(page: Page, pts: Record<string, { name: string; x: number; y: number }>) {
  return page.evaluate((p) => {
    const link = document.querySelector('[data-slot="ds-list-row"] a[href]')!;
    return Object.fromEntries(Object.entries(p).map(([k, v]) => { const h = document.elementFromPoint(v.x, v.y); return [k, { name: v.name, link: !!h && (h === link || link.contains(h)), at: h ? `${h.tagName.toLowerCase()}${h.closest('[data-avatar]') ? ' in the avatar' : ''}` : 'nothing' }]; }));
  }, pts);
}

for (const width of [390, 1440]) {
  test.describe(`the attention row · ${width}`, () => {
    if (width < 500) test.use({ hasTouch: true, isMobile: true });

    test('every part of the row answers as the row\'s link (title · avatar · verb · gap · padding)', async ({ page }) => {
      await open(page, width);
      const pts = await probes(page);
      const got = await answers(page, pts);
      // the evidence picture: each asked point marked (green = the link answers, red = something else), taken BEFORE the check
      await page.evaluate(({ pts: p, got: g }) => {
        for (const [k, v] of Object.entries(p as Record<string, { x: number; y: number }>)) {
          const ok = (g as Record<string, { link: boolean }>)[k]!.link;
          const d = document.createElement('div');
          d.style.cssText = `position:fixed;left:${v.x - 6}px;top:${v.y - 6}px;width:12px;height:12px;border-radius:50%;background:${ok ? '#16a34a' : '#dc2626'};opacity:.85;z-index:99999;pointer-events:none`;
          document.body.appendChild(d);
        }
      }, { pts, got });
      await shot(page, page.locator('#frame'), `attention-row-press-${width}`);
      const wrong = Object.values(got).filter((a) => !a.link).map((a) => `${a.name} → ${a.at}`);
      expect(wrong, 'parts of the row that do NOT answer as its link (a press there would not navigate)').toEqual([]);
    });

    test('a real click on the avatar and on the verb reaches the link (the row navigates)', async ({ page }) => {
      await open(page, width);
      const pts = await probes(page);
      await page.mouse.click(pts.avatar.x, pts.avatar.y);
      await page.mouse.click(pts.verb.x, pts.verb.y);
      const navigated = await page.evaluate(() => (window as unknown as { __navigated: string[] }).__navigated);
      expect(navigated, 'the link handler got both clicks (avatar, verb)').toEqual([ITEM.href, ITEM.href]);
    });
  });
}
