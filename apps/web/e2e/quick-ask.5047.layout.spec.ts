/**
 * story 5047 (C14 · PO 11-27) — the quick-ask window's page at the window's own width (560), on the REAL QuickAsk component (bundled with esbuild — not copied) and the real Tailwind build (harness = onboarding.5036.states.layout.spec.ts:
 * no server of ours, the API answers are made here; the Mac app's bridge is a fake that records what the page reports). The window is 560 wide and the app keeps its height within 64–420: every scene asserts
 *   · nothing wider than the window · the page's height is what the bridge was told (the app sizes the window by it) and stays within the 420 the app allows
 *   · no text under 12 px · no old (non-ds) part drawn · a press never wraps to a second line
 * and the worst case (a long failure + the window's picture + a long target name + words with no space to break at) is one of the scenes.
 * Names `5047-{scene}-{L}.png`. Files go to CAPTURE_OUT when set, else this test's output folder.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { compile, optimize } from '@tailwindcss/node';
import { layoutStubPlugin } from './support/layout-stubs';
import { tailwindCandidates } from './support/tailwind-candidates';

const req = createRequire(__filename);
const WEB = path.join(__dirname, '..');
const APP = path.join(WEB, 'src', 'app');
const WIDTH = 560; // the window's own width (desktop-electron/src/quick-ask.ts QUICK_WIDTH)
const MAX_HEIGHT = 420; // …and the tallest the app lets it be (QUICK_MAX_HEIGHT)

let built: { js: string; css: string } | null = null;
async function build() {
  if (built) return built;
  const esbuild = req('esbuild') as typeof import('esbuild');
  const out = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react'; import { createRoot } from 'react-dom/client'; import { NextIntlClientProvider } from 'next-intl';
        import ko from './messages/ko.json'; import en from './messages/en.json';
        import { QuickAsk } from './src/app/quick/quick-ask';
        const h = React.createElement;
        window.__mount = (locale) => {
          const root = createRoot(document.getElementById('root'));
          root.render(h(NextIntlClientProvider, { locale, messages: locale === 'en' ? en : ko, timeZone: 'Asia/Seoul' }, h(QuickAsk)));
        };`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [layoutStubPlugin()],
  });
  const js = out.outputFiles[0]!.text;
  const candidates = tailwindCandidates(js);
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  const css = (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(candidates), { minify: false }).code;
  built = { js, css };
  return built;
}

const AGENTS = [
  { id: 'a1', name: 'Dan', runtime_type: 'claude-code' },
  { id: 'a2', name: 'Mirko', runtime_type: 'claude-code' },
  { id: 'a3', name: 'Maximilian-Alexander-von-Hohenzollern-Sigmaringen-und-Guldenstern-Rosenkrantz-Wittgenstein', runtime_type: 'codex' }, // 92 letters, no space to break at: wider than the window, so it MUST be cut
];
const API: Record<string, unknown> = {
  'GET /api/current-project': { data: { project_id: 'p1', project_name: '첫 프로젝트', org_id: 'o1' } },
  'GET /api/team-members': { data: AGENTS },
  'GET /api/conversations': { data: [{ id: 'ch1', type: 'group', is_project_channel: true }], total: 1 },
};
// a tiny real PNG (a grey 8×6) so the preview draws as an image
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAYAAAD+Bd/7AAAAFUlEQVR4nGP8//8/AzbAxIAKRqUAAgAB9QMBc3hcOgAAAABJRU5ErkJggg==';
const BASE = { open: true, phase: 'empty', text: '', target: null, pickQuery: '', attach: { kind: 'off' }, failure: null };

async function open(page: Page, locale: 'ko' | 'en') {
  const { js, css } = await build();
  await page.setViewportSize({ width: WIDTH, height: 700 });
  await page.unrouteAll();
  await page.route('http://preview.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><style>${css}</style></head><body style="margin:0"><div id="root"></div></body></html>` });
    }
    const a = API[`${route.request().method()} ${url.pathname}`];
    if (a === undefined) return route.fulfill({ status: 404, body: '{}' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(a) });
  });
  await page.goto('about:blank');
  await page.goto('http://preview.test/');
  // the Mac app's bridge, as a fake: what the page is told is pushed by `__push`; what it reports is recorded
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__events = []; w.__heights = [];
    w.quickAsk = {
      onState: (fn: (s: unknown) => void) => { w.__push = fn; return () => undefined; },
      onPost: () => () => undefined,
      event: async (e: unknown) => { (w.__events as unknown[]).push(e); },
      resize: (h: number) => { (w.__heights as number[]).push(h); },
      ready: () => undefined,
    };
  });
  const thrown: string[] = [];
  page.on('pageerror', (e) => thrown.push(e.message));
  await page.addScriptTag({ content: js });
  if (!(await page.evaluate(() => typeof (window as unknown as { __mount?: unknown }).__mount === 'function'))) throw new Error(`the bundle did not start: ${thrown.join(' | ') || 'no page error'}`);
  await page.evaluate((l) => (window as unknown as { __mount: (l: string) => void }).__mount(l), locale);
  // the page listens for the app's state from an effect: wait until it is listening (a condition, not a pause)
  await page.waitForFunction(() => typeof (window as unknown as { __push?: unknown }).__push === 'function');
}

const frames = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1)))));
const push = async (page: Page, state: object) => { await page.evaluate((s) => (window as unknown as { __push: (s: unknown) => void }).__push(s), { ...BASE, ...state }); await frames(page); await frames(page); };
const outDir = () => { const d = process.env['CAPTURE_OUT'] || test.info().outputDir; mkdirSync(d, { recursive: true }); return d; };

/** the measure every scene runs */
async function clean(page: Page, label: string) {
  const m = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="quick-root"]') as HTMLElement;
    const rootH = root.getBoundingClientRect().height;
    const reported = ((window as unknown as { __heights: number[] }).__heights).at(-1) ?? -1;
    const shown = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
    const leaves = [...document.querySelectorAll('body *')].filter((e) => e.children.length === 0 && (e.textContent || '').trim() && shown(e));
    const tiny = leaves.filter((e) => parseFloat(getComputedStyle(e).fontSize) < 12).map((e) => `${(e.textContent || '').trim().slice(0, 20)} ${getComputedStyle(e).fontSize}`);
    const oldSlots = [...document.querySelectorAll('[data-slot]')].map((e) => e.getAttribute('data-slot')!).filter((s) => !s.startsWith('ds-'));
    // a press (button) whose text wrapped to a second line
    const wrapped = [...document.querySelectorAll('button')].filter(shown).filter((b) => b.getBoundingClientRect().height > 44).map((b) => (b.textContent || '').trim().slice(0, 20));
    // anything that sticks out of the window on the right
    const out = [...document.querySelectorAll('[data-testid="quick-root"] *')].filter(shown).filter((e) => e.getBoundingClientRect().right > innerWidth + 0.5).map((e) => (e.getAttribute('data-testid') || e.tagName).toString());
    return { rootH, reported, tiny, oldSlots, wrapped, out, overflowX: document.documentElement.scrollWidth > innerWidth + 1 };
  });
  expect(m.overflowX, `${label}: wider than the window`).toBe(false);
  expect(m.out, `${label}: sticks out on the right: ${m.out.join(' · ')}`).toEqual([]);
  expect(Math.abs(m.reported - Math.ceil(m.rootH)), `${label}: the app was told ${m.reported}, the page is ${m.rootH} high`).toBeLessThanOrEqual(1);
  expect(m.rootH, `${label}: ${m.rootH} px is over the ${MAX_HEIGHT} the app allows`).toBeLessThanOrEqual(MAX_HEIGHT);
  expect(m.tiny, `${label}: text under 12 px: ${m.tiny.join(' · ')}`).toEqual([]);
  expect(m.oldSlots, `${label}: old (non-ds) parts drawn`).toEqual([]);
  expect(m.wrapped, `${label}: a press wraps to a second line: ${m.wrapped.join(' · ')}`).toEqual([]);
  return m;
}
async function shot(page: Page, name: string) {
  await page.mouse.move(0, 0);
  await frames(page);
  await page.locator('[data-testid="quick-root"]').screenshot({ path: path.join(outDir(), `5047-${name}.png`) });
}

for (const locale of ['ko', 'en'] as const) {
  const L = locale;
  test.describe(`the quick-ask window · 560 · ${L}`, () => {
    test(`empty · the hint · ${L}`, async ({ page }) => {
      await open(page, L);
      await push(page, {});
      const m = await clean(page, 'empty');
      expect(m.rootH, 'empty: one input row + the footer, not a tall box').toBeLessThanOrEqual(130);
      await shot(page, `empty-${L}`);
    });

    test(`picking · the list of places · ${L}`, async ({ page }) => {
      await open(page, L);
      await push(page, { phase: 'picking' });
      await expect(page.locator('[role="option"]')).toHaveCount(4); // the channel + the three agents
      const m = await clean(page, 'picking');
      // the long agent name is cut with an ellipsis, not pushed out of the window
      const longRow = page.locator('[role="option"]').nth(3);
      expect(await longRow.evaluate((e) => (e.querySelector('span') as HTMLElement).scrollWidth > (e.querySelector('span') as HTMLElement).clientWidth)).toBe(true);
      expect(m.rootH).toBeLessThanOrEqual(MAX_HEIGHT);
      await shot(page, `picking-${L}`);
    });

    test(`a target chosen · words with no space to break at · ${L}`, async ({ page }) => {
      await open(page, L);
      await push(page, { target: { kind: 'agent', id: 'a3', name: AGENTS[2]!.name }, text: '가나다라마바사아자차카타파하'.repeat(12) });
      await clean(page, 'target + long words');
      // the chip leaves room for the words: the input is at least a third of the row
      const w = await page.getByTestId('quick-input').evaluate((e) => e.getBoundingClientRect().width);
      expect(w, 'the input was squeezed out by the chip').toBeGreaterThan(WIDTH / 3);
      await shot(page, `target-long-${L}`);
    });

    test(`sending · the input is locked · ${L}`, async ({ page }) => {
      await open(page, L);
      await push(page, { phase: 'sending', text: 'hi', target: { kind: 'channel', id: 'ch1', name: '첫 프로젝트' } });
      await expect(page.getByTestId('quick-input')).toBeDisabled();
      await clean(page, 'sending');
      await shot(page, `sending-${L}`);
    });

    for (const failure of ['rejected', 'server', 'offline'] as const) {
      test(`failed · ${failure} · the reason line and the way to try again · ${L}`, async ({ page }) => {
        await open(page, L);
        await push(page, { phase: 'failed', failure, text: '오늘 일 정리해 줘', target: { kind: 'agent', id: 'a1', name: 'Dan' } });
        await expect(page.getByTestId('quick-failure')).toBeVisible();
        await clean(page, `failed ${failure}`);
        await shot(page, `failed-${failure}-${L}`);
      });
    }

    test(`login · the way to the app · ${L}`, async ({ page }) => {
      await open(page, L);
      await push(page, { phase: 'login', failure: 'login', text: 'hi', target: { kind: 'agent', id: 'a1', name: 'Dan' } });
      await expect(page.getByTestId('quick-login')).toBeVisible();
      await clean(page, 'login');
      await shot(page, `login-${L}`);
    });

    test(`discard · the question before words that did not go are thrown away · ${L}`, async ({ page }) => {
      await open(page, L);
      await push(page, { phase: 'discard', failure: 'server', text: 'hi', target: { kind: 'agent', id: 'a1', name: 'Dan' } });
      await expect(page.getByTestId('quick-discard')).toBeVisible();
      await clean(page, 'discard');
      await shot(page, `discard-${L}`);
    });

    test(`the window's picture · denied · capturing · ready (a long name) · ${L}`, async ({ page }) => {
      await open(page, L);
      await push(page, { attach: { kind: 'denied', permission: 'denied' } });
      await clean(page, 'denied');
      await shot(page, `attach-denied-${L}`);
      await push(page, { attach: { kind: 'capturing' } });
      await clean(page, 'capturing');
      await push(page, { attach: { kind: 'ready', preview: { dataUrl: PNG, label: '창 · 터미널 — 민 레 세션 · 아주 긴 이름의 작업 폴더 이름이 이어지는 경우의 한 줄 처리' } } });
      await expect(page.getByTestId('quick-preview').locator('img')).toHaveCount(1);
      await clean(page, 'preview');
      await shot(page, `attach-ready-${L}`);
    });

    test(`the worst case: a long failure + the picture + a long target + long words · ${L}`, async ({ page }) => {
      await open(page, L);
      await push(page, {
        phase: 'failed', failure: 'offline', text: '가나다라마바사아자차카타파하'.repeat(12),
        target: { kind: 'agent', id: 'a3', name: AGENTS[2]!.name },
        attach: { kind: 'ready', preview: { dataUrl: PNG, label: '창 · 터미널 — 민 레 세션 · 아주 긴 이름의 작업 폴더 이름이 이어지는 경우의 한 줄 처리' } },
      });
      await clean(page, 'worst case');
      await shot(page, `worst-${L}`);
    });
  });
}
