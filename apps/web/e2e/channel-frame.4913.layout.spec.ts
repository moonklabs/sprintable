/**
 * story 4913 (UI-R5 · 채널) — the channel screen on the one-page frame, measured in Chromium with the REAL `ChannelPage` (bundled with esbuild, not copied) and the real Tailwind build of globals.css.
 * The rules: PageFrame stream (the content takes the width the shell gives it, no centred narrow column) · a head with one description line and ONE text chip for the connection · the messages as rows on the ds layers
 * (others = rowOthers with the name above, mine = rowMine on the right, a column that stops at a reading width) · the composer is one bordered field with the clip and the send as ds icon buttons, stuck to the bottom of the frame ·
 * nothing overflows sideways on a phone, and on a touch screen every control keeps a ≥ 44 px press area.
 */
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { compile, optimize } from '@tailwindcss/node';
import type { Plugin } from 'esbuild';
import { layoutStubPlugin } from './support/layout-stubs';
import { tailwindCandidates } from './support/tailwind-candidates';

const req = createRequire(__filename);
const WEB = path.join(__dirname, '..');
const APP = path.join(WEB, 'src', 'app');
const SHOTS = process.env.CHANNEL_SHOTS; // local runs only: a folder to keep the screenshots in
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

/** this spec's own stubs, ahead of the shared list: the page reads `useSearchParams` and the title goes to the shell's top bar slot (not drawn here) */
function channelStubs(): Plugin {
  const MODS: Record<string, string> = {
    'next/navigation': "export function useSearchParams() { return new URLSearchParams(window.__search || ''); } export function useRouter() { return { push() {}, replace() {} }; } export function usePathname() { return '/channel'; }",
    '@/components/nav/top-bar-slot': 'export function TopBarSlot() { return null; }',
  };
  return {
    name: 'channel-stubs',
    setup(b) {
      b.onResolve({ filter: /^(next\/navigation|@\/components\/nav\/top-bar-slot)$/ }, (a) => ({ path: a.path, namespace: 'channel-stub' }));
      b.onLoad({ filter: /.*/, namespace: 'channel-stub' }, (a) => ({ contents: MODS[a.path]!, loader: 'js', resolveDir: WEB }));
    },
  };
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
        import ChannelPage from './src/app/(authenticated)/channel/page';
        window.__mount = () => {
          createRoot(document.getElementById('root')).render(React.createElement(NextIntlClientProvider, { locale: 'ko', messages: ko, timeZone: 'Asia/Seoul' },
            React.createElement('div', { id: 'shell-scroller', style: { height: '100vh', overflowY: 'auto', display: 'flex', flexDirection: 'column' } }, React.createElement(ChannelPage))));
        };`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_APP_URL': '"https://app.sprintable.ai"' },
    plugins: [channelStubs(), layoutStubPlugin()],
  });
  const js = out.outputFiles[0]!.text;
  // class names live in "…" strings, in `…` template literals and inside `${…}` expressions of those (quotes nest and pair up wrongly): take every token, Tailwind ignores the ones that are not utilities
  const candidates = tailwindCandidates(js);
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  const css = (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(candidates), { minify: false }).code;
  built = { js, css };
  return built;
}

const LONG = '긴 글: ' + '채널은 에이전트와 사람이 주고받는 흐름이에요. '.repeat(8);
async function open(page: Page, width: number, opts: { dark?: boolean; connected?: boolean } = {}) {
  const { js, css } = await build();
  await page.setViewportSize({ width, height: 800 });
  await page.unrouteAll();
  await page.emulateMedia({ colorScheme: opts.dark ? 'dark' : 'light' });
  await page.addInitScript(({ connected, long }) => {
    const w = window as unknown as Record<string, unknown>;
    w.__search = 'agent_id=ag-1';
    w.__dashboardCtx = { currentTeamMemberId: 'me-1' };
    const ts = (min: number) => new Date(Date.now() - min * 60000).toISOString();
    class FakeWS {
      static OPEN = 1; readyState = 0; onopen: (() => void) | null = null; onclose: (() => void) | null = null; onerror: (() => void) | null = null; onmessage: ((e: { data: string }) => void) | null = null;
      constructor() {
        setTimeout(() => {
          if (!connected) { this.onclose?.(); return; }
          this.readyState = 1; this.onopen?.();
          for (const m of [
            { id: 'a', sender_id: 'me-1', sender_name: '나', content: '배포 상태를 알려 주세요.', ts: ts(50) },
            { id: 'b', sender_id: 'ag-1', sender_name: '시험 에이전트', content: '확인했어요. 지금 스테이징에 올라가 있고 헬스 체크는 초록이에요.', ts: ts(49) },
            { id: 'c', sender_id: 'ag-1', sender_name: '시험 에이전트', content: long, ts: ts(20) },
            { id: 'd', sender_id: 'me-1', sender_name: '나', content: '파일을 보냈어요', ts: ts(10), file_url: '/api/v2/channel/files/x/report.pdf' },
            { id: 'e', sender_id: 'ag-1', sender_name: '시험 에이전트', content: '줄 하나\n줄 둘\n줄 셋', ts: ts(5) },
            { id: 'f', sender_id: 'me-1', sender_name: '나', content: '고마워요, 다음 칸으로 가요.', ts: ts(1) },
          ]) this.onmessage?.({ data: JSON.stringify(m) });
        }, 30);
      }
      send() {} close() {}
    }
    w.WebSocket = FakeWS;
  }, { connected: opts.connected !== false, long: LONG });
  await page.route('http://preview.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ko" class="${opts.dark ? 'dark' : ''}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body style="margin:0" class="bg-ds-background"><div id="root"></div></body></html>` });
    }
    if (url.pathname.endsWith('/api/channel/token')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ token: 't', backend_origin: 'https://api.test' }) });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [] }) });
  });
  await page.goto('about:blank');
  await page.goto('http://preview.test/');
  await page.addScriptTag({ content: js });
  await page.evaluate(() => (window as unknown as { __mount: () => void }).__mount());
  await page.getByTestId('channel-page').waitFor();
  if (opts.connected !== false) await expect(page.getByTestId('channel-message')).toHaveCount(6);
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
}
const box = async (page: Page, id: string, i = 0) => (await page.getByTestId(id).nth(i).boundingBox())!;
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };

test('[SID:4913] desktop: the frame takes the shell width (stream), the head is one description line with the status chip on the right, and the messages stand as rows — mine on the right, others on the left, none wider than a reading column', async ({ page }) => {
  await open(page, 1100);
  await shot(page, 'desktop-light');
  const frame = (await page.locator('[data-slot="ds-page-frame"]').boundingBox())!;
  expect(frame.width, `the frame fills the width the shell gives (${Math.round(frame.width)} of 1100)`).toBeGreaterThanOrEqual(1090); // reverted (reading 768) → ≤ 768
  const head = (await page.locator('[data-slot="ds-page-head"]').boundingBox())!;
  const chip = await box(page, 'channel-status');
  expect(chip.x + chip.width, 'the chip is at the right end of the head').toBeGreaterThan(frame.x + frame.width - 40);
  expect(head.height, `the head is one short row (${Math.round(head.height)} px)`).toBeLessThanOrEqual(40);
  const rows = page.getByTestId('channel-message');
  for (let i = 0; i < 6; i += 1) {
    const r = await rows.nth(i).boundingBox();
    const own = (await rows.nth(i).getAttribute('data-own')) === 'true';
    const bubble = (await rows.nth(i).locator('.bg-ds-mine, .bg-ds-surface-high').first().boundingBox())!;
    expect(bubble.width, `row ${i}: the bubble stops at a reading width (${Math.round(bubble.width)} px)`).toBeLessThanOrEqual(660);
    const cls = await rows.nth(i).getAttribute('class');
    // the BUBBLE (not the row, which always spans the frame) sits at the edge of its side
    if (own) expect(Math.abs(bubble.x + bubble.width - (frame.x + frame.width - 24)), `row ${i} (mine) bubble is on the right edge — row class: ${cls}`).toBeLessThanOrEqual(40);
    else expect(Math.abs(bubble.x - (frame.x + 24)), `row ${i} (others) bubble starts at the left edge — row class: ${cls}`).toBeLessThanOrEqual(40);
    void r;
  }
  const longBubble = (await rows.nth(2).locator('.bg-ds-surface-high').first().boundingBox())!;
  expect(longBubble.height, 'the long message wraps into several lines').toBeGreaterThan(60);
});

test('[SID:4913] the faces are the ds layers (others = surface-high, mine = ds-mine) and the text keeps a 4.5:1 contrast on them, light and dark', async ({ page }) => {
  for (const dark of [false, true]) {
    await open(page, 1100, { dark });
    if (dark) await shot(page, 'desktop-dark');
    const r = await page.evaluate(() => {
      const px = (css: string) => { const c = document.createElement('canvas'); c.width = c.height = 1; const g = c.getContext('2d')!; g.clearRect(0, 0, 1, 1); g.fillStyle = css; g.fillRect(0, 0, 1, 1); const d = g.getImageData(0, 0, 1, 1).data; return [d[0]!, d[1]!, d[2]!, d[3]! / 255] as const; };
      const lum = (c: readonly number[]) => { const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]!) + 0.7152 * f(c[1]!) + 0.0722 * f(c[2]!); };
      const token = (cls: string) => { const p = document.createElement('div'); p.className = cls; document.body.appendChild(p); const v = getComputedStyle(p).backgroundColor; p.remove(); return v; };
      const out: Record<string, number | string> = {};
      for (const [name, sel, cls] of [['others', '.bg-ds-surface-high', 'bg-ds-surface-high'], ['mine', '.bg-ds-mine', 'bg-ds-mine']] as const) {
        const el = document.querySelector(`[data-testid="channel-message"] ${sel}`)!;
        const cs = getComputedStyle(el);
        out[`${name} face is the token`] = cs.backgroundColor === token(cls) ? 1 : 0;
        const text = el.querySelector('p')!; const fg = px(getComputedStyle(text).color); const bg = px(cs.backgroundColor);
        const a = lum(fg), b = lum(bg); out[`${name} text contrast`] = Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
      }
      return out;
    });
    for (const name of ['others', 'mine']) {
      expect(r[`${name} face is the token`], `${dark ? 'dark' : 'light'} ${name}: ${JSON.stringify(r)}`).toBe(1);
      expect(r[`${name} text contrast`] as number, `${dark ? 'dark' : 'light'} ${name}: ${JSON.stringify(r)}`).toBeGreaterThanOrEqual(4.5);
    }
  }
});

test('[SID:4913] the composer is one bordered field stuck to the bottom of the frame: the textarea, the clip and the send share a line, the send is the primary action', async ({ page }) => {
  await open(page, 1100);
  await page.evaluate(() => { const s = document.getElementById('shell-scroller')!; s.scrollTop = 0; });
  const composer = await box(page, 'channel-composer');
  const input = await box(page, 'channel-input');
  const send = await box(page, 'channel-send');
  const vh = 800;
  expect(composer.y + composer.height, `the composer is at the bottom of the window even with the list scrolled to the top (${Math.round(composer.y + composer.height)})`).toBeGreaterThanOrEqual(vh - 30);
  expect(Math.abs((send.y + send.height / 2) - (input.y + input.height / 2)), 'the send is on the field line').toBeLessThanOrEqual(30);
  const border = await page.getByTestId('channel-composer').evaluate((e) => getComputedStyle(e).borderTopWidth);
  expect(border).toBe('1px');
  await page.getByTestId('channel-input').fill('보낼 글');
  const filled = await page.getByTestId('channel-send').evaluate((e) => getComputedStyle(e).backgroundColor);
  expect(filled, 'with text the primary icon button is filled (empty it is the dashed disabled one)').not.toBe('rgba(0, 0, 0, 0)');
});

test('[SID:4913] disconnected: the chip says so in words and a note line explains what happens to what is sent', async ({ page }) => {
  await open(page, 1100, { connected: false });
  await expect(page.getByTestId('channel-disconnected')).toBeVisible();
  const chip = await page.getByTestId('channel-status').textContent();
  expect(chip).toBe('연결 끊김');
  await shot(page, 'desktop-disconnected');
});

test.describe('on a phone', () => {
  test.use({ hasTouch: true, isMobile: true });
  test('[SID:4913] 390 wide: nothing overflows sideways, the head folds under the description, and every control keeps a press area of at least 44 px', async ({ page }) => {
    await open(page, 390);
    await shot(page, 'phone-light');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, 'no horizontal overflow').toBeLessThanOrEqual(0);
    const small = await page.evaluate(() => [...document.querySelectorAll('[data-testid="channel-page"] button')].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && (r.width < 43.5 || r.height < 43.5); }).map((b) => `${b.getAttribute('aria-label')}:${Math.round(b.getBoundingClientRect().width)}x${Math.round(b.getBoundingClientRect().height)}`));
    expect(small, 'every button is at least 44 x 44 on a touch screen').toEqual([]);
    const rows = page.getByTestId('channel-message');
    for (let i = 0; i < 6; i += 1) {
      const r = (await rows.nth(i).boundingBox())!;
      expect(r.x + r.width, `row ${i} stays inside the screen`).toBeLessThanOrEqual(390 + 0.5);
    }
  });
});
