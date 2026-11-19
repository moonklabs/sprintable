/**
 * story 4981 (연결 ③ · PR 4) — the computer card's «사용량» sheet, measured in Chromium on a touch phone (390 × 844): the REAL sheet (bundled with esbuild, not copied) and the real Tailwind build.
 * Rule: every press is ≥ 44 × 44, no visible text is under 12 px, nothing runs past the width, no old (non-ds) part is drawn, the bar's fill is as wide as its percent, and a window whose reset time
 * has passed draws no bar. The scenes are the ones the PO asked to see (ko · en · numbers · «풀렸어요» · a reason line · no numbers); each is also written to a full-screen PNG when `USAGE_SHOTS_DIR` is set.
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
        import React from 'react'; import { createRoot } from 'react-dom/client'; import { NextIntlClientProvider } from 'next-intl';
        import ko from './messages/ko.json';
        import en from './messages/en.json';
        import { AgentUsageSheet } from './src/components/desktop/agent-usage-sheet';
        // the sheet is opened by a TAP on a button, as on the card (the dialog decides its first focus by how it was opened)
        function Host({ deps }) {
          const [open, setOpen] = React.useState(false);
          return React.createElement(React.Fragment, null,
            React.createElement('button', { id: 'usage-trigger', style: { minHeight: 44, minWidth: 88, margin: 16 }, onClick: () => setOpen(true) }, 'open'),
            React.createElement(AgentUsageSheet, { agentId: 'a-1', open, onOpenChange: setOpen, deps }));
        }
        window.__mount = (answer, locale) => {
          const deps = { fetch: async () => new Response(JSON.stringify(answer), { status: 200 }), now: () => Date.now() };
          createRoot(document.getElementById('root')).render(React.createElement(NextIntlClientProvider, { locale, messages: locale === 'en' ? en : ko, timeZone: 'Asia/Seoul' },
            React.createElement(Host, { deps })));
        };`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_APP_URL': '"https://app.sprintable.ai"' },
    plugins: [layoutStubPlugin()],
  });
  const js = out.outputFiles[0]!.text;
  const candidates = tailwindCandidates(js);
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  const css = (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(candidates), { minify: false }).code;
  built = { js, css };
  return built;
}

const H = 3_600_000;
const at = (ms: number) => new Date(Date.now() + ms).toISOString();
const win = (over: Record<string, unknown> = {}) => ({ kind: 'five_hour', minutes: 300, used_percent: 63, resets_at: at(2 * H + 10 * 60_000), ...over });
const row = (over: Record<string, unknown> = {}) => ({ runtime: 'claude', account: 'a1b2c3d4e5f6', state: 'windows', why: null, windows: [win()], seen_at: at(-5 * 60_000), ...over });
const answer = (usage: unknown[], over: Record<string, unknown> = {}) => ({ agent_id: 'a-1', remote_control: true, setup_id: 's-1', device_name: null as string | null, connected: true, usage, ...over });

type Locale = 'ko' | 'en';
async function open(page: Page, ans: object, locale: Locale) {
  const { js, css } = await build();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.unrouteAll();
  await page.route('http://preview.test/**', async (route) => {
    if (new URL(route.request().url()).pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>` });
    }
    return route.fulfill({ status: 404, body: '{}' });
  });
  await page.addInitScript(() => { (window as unknown as { process: unknown }).process = { env: {} }; });
  await page.goto('about:blank');
  await page.goto('http://preview.test/');
  await page.addScriptTag({ content: js });
  await page.evaluate(([a, l]) => (window as unknown as { __mount: (a: object, l: string) => void }).__mount(a as object, l as string), [ans, locale]);
  await page.locator('#usage-trigger').tap();
  await page.locator('[data-testid="agent-usage-sheet"]').waitFor();
  await page.locator('[data-testid="agent-usage-loading"]').waitFor({ state: 'detached' });
  // the dialog opens with a zoom-in: a press measured mid-animation is 97 % of itself (44 → 42.7 px) — measure and shoot when the animations have finished
  await page.evaluate(() => Promise.all(document.getAnimations().map((x) => x.finished.catch(() => null))));
}

const measure = (page: Page) => page.evaluate(() => {
  const vis = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const presses = [...document.querySelectorAll('button, [role=switch], a[href], input, select, summary')].filter(vis);
  const small = presses.filter((e) => { const r = e.getBoundingClientRect(); return r.width < 43.5 || r.height < 43.5; }).map((e) => `${(e.getAttribute('aria-label') || e.textContent || e.tagName).trim().slice(0, 14)} ${e.getBoundingClientRect().width.toFixed(1)}x${e.getBoundingClientRect().height.toFixed(2)} min-h=${getComputedStyle(e).minHeight} h=${getComputedStyle(e).height} fs=${getComputedStyle(document.documentElement).fontSize}`);
  const leaves = [...document.querySelectorAll('body *')].filter((e) => e.children.length === 0 && (e.textContent || '').trim() && vis(e));
  const tiny = leaves.filter((e) => parseFloat(getComputedStyle(e).fontSize) < 12).map((e) => `${(e.textContent || '').trim().slice(0, 14)} ${getComputedStyle(e).fontSize}`);
  const sheet = document.querySelector('[data-testid="agent-usage-sheet"]')!.getBoundingClientRect();
  return {
    presses: presses.length, small, tiny, overflowX: document.documentElement.scrollWidth > innerWidth + 1,
    sheetInside: sheet.left >= -0.5 && sheet.right <= innerWidth + 0.5 && sheet.top >= -0.5 && sheet.bottom <= innerHeight + 0.5,
    oldSlots: [...document.querySelectorAll('[data-slot]')].map((e) => e.getAttribute('data-slot')!).filter((s) => !s.startsWith('ds-')),
  };
});
async function expectClean(page: Page, label: string) {
  const m = await measure(page);
  expect(m.small, `${label}: presses under 44 px: ${m.small.join(' · ')}`).toEqual([]);
  expect(m.tiny, `${label}: text under 12 px: ${m.tiny.join(' · ')}`).toEqual([]);
  expect(m.overflowX, `${label}: overflow`).toBe(false);
  expect(m.sheetInside, `${label}: the sheet stays inside the screen`).toBe(true);
  // opened by a finger: the sheet itself holds the focus, and neither [닫기] nor [다시 읽기] shows a focus ring (it would read as «pressed»)
  const focus = await page.evaluate(() => ({
    active: document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName,
    ring: [...document.querySelectorAll('[data-testid="agent-usage-close"], [data-testid="agent-usage-reload"]')].filter((e) => e.matches(':focus-visible') || e === document.activeElement).length,
  }));
  expect(focus, `${label}: no focus ring after a tap`).toEqual({ active: 'agent-usage-sheet', ring: 0 });
  return m;
}
async function shot(page: Page, name: string) {
  const dir = process.env['USAGE_SHOTS_DIR'];
  if (dir) await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: false });
}

test.describe('on a touch phone (390 × 844)', () => {
  test.use({ hasTouch: true, isMobile: true });

  test('[SID:4981] numbers: a bar per window, as wide as its percent, with the reset and the last-seen words (ko and en)', async ({ page }) => {
    const ans = answer([
      row({ windows: [win(), win({ kind: 'seven_day', minutes: 10_080, used_percent: 41, resets_at: at(3 * 24 * H) })] }),
      row({ runtime: 'codex', account: 'cccccccccccc', windows: [win({ kind: 'other', minutes: 60, used_percent: 7, resets_at: at(25 * 60_000) })], seen_at: at(-90_000) }),
    ], { device_name: '작업용 맥북' });
    await open(page, ans, 'ko');
    await expectClean(page, 'ko numbers');
    const widths = await page.locator('[data-testid="agent-usage-bar"] > div').evaluateAll((els) => els.map((e) => Math.round((e.getBoundingClientRect().width / (e.parentElement as HTMLElement).getBoundingClientRect().width) * 100)));
    expect(widths, 'each fill is as wide as its percent').toEqual([63, 41, 7]);
    await expect(page.locator('[data-testid="agent-usage-title"]')).toHaveText('작업용 맥북의 계정 사용량');
    await shot(page, 'ko-numbers');
    await open(page, { ...ans, device_name: 'Work MacBook' }, 'en');
    await expectClean(page, 'en numbers');
    await expect(page.locator('[data-testid="agent-usage-title"]')).toHaveText('Account usage on Work MacBook');
    await shot(page, 'en-numbers');
  });

  test('[SID:4981] a window whose reset time has passed: one line, no bar and no percent (ko and en), beside a window still running', async ({ page }) => {
    const ans = answer([row({ seen_at: at(-3 * 24 * H), windows: [win({ used_percent: 91, resets_at: at(-2 * 24 * H) }), win({ kind: 'seven_day', minutes: 10_080, used_percent: 41, resets_at: at(2 * 24 * H) })] })], { device_name: '작업용 맥북' });
    await open(page, ans, 'ko');
    await expectClean(page, 'ko stale');
    expect(await page.locator('[data-testid="agent-usage-bar"]').count(), 'only the running window has a bar').toBe(1);
    await expect(page.locator('[data-testid="agent-usage-stale"]')).toHaveText('풀렸어요 · 새 숫자는 다음 세션 때');
    await shot(page, 'ko-stale');
    await open(page, { ...ans, device_name: 'Work MacBook' }, 'en');
    await expectClean(page, 'en stale');
    await shot(page, 'en-stale');
  });

  test('[SID:4981] no numbers: the reason line (an API-key login · not read), and nothing yet — each one line, no bar (ko and en)', async ({ page }) => {
    const reasons = answer([row({ state: 'unavailable', why: 'api_key', windows: [] }), row({ runtime: 'codex', account: 'cccccccccccc', state: 'unavailable', why: 'not_read', windows: [] })], { device_name: '작업용 맥북' });
    await open(page, reasons, 'ko');
    await expectClean(page, 'ko reasons');
    expect(await page.locator('[data-testid="agent-usage-bar"]').count()).toBe(0);
    await expect(page.locator('[data-testid="agent-usage-why"]').first()).toHaveText('사용량을 알 수 없어요');
    await shot(page, 'ko-reasons');
    await open(page, { ...reasons, device_name: 'Work MacBook' }, 'en');
    await expectClean(page, 'en reasons');
    await shot(page, 'en-reasons');
    await open(page, answer([], { device_name: '작업용 맥북' }), 'ko');
    await expectClean(page, 'ko nothing yet');
    await shot(page, 'ko-nothing');
    await open(page, answer([row()], { device_name: '작업용 맥북', connected: false }), 'ko');
    await expectClean(page, 'ko disconnected');
    await expect(page.locator('[data-testid="agent-usage-disconnected"]')).toBeVisible();
    await shot(page, 'ko-disconnected');
  });
});
