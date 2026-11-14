/**
 * story 4906 (lap 3 · PO 11-14) — the line above a room's composer when the home's instruction was moved there instead of sent: «홈에서 쓴 글을 가장 최근 방 ‹방 이름›에 옮겨 두었어요 — … 바로 보내지 않았어요».
 * The REAL notice component (components/chat/compose-moved-notice.tsx · the ds Banner) with the REAL Korean message and the real Tailwind build, above a stand-in composer row, at 1440 × 900 and
 * 390 × 844 (phone) — with a short and a LONG room name. Rule: the line stands fully above the composer (no overlap), is as wide as the column, nothing runs sideways, the text is ≥ 12 px and the room
 * name is in it. Pictures go to $NOTICE_SHOT_DIR when it is set (the PR's «390 / 1440 그림»).
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
        import { ComposeMovedNotice } from './src/components/chat/compose-moved-notice';
        const intl = (child) => React.createElement(NextIntlClientProvider, { locale: 'ko', messages: ko, timeZone: 'Asia/Seoul' }, child);
        // a room column's bottom: a few messages, then the notice, then the composer (a bordered box with the moved text)
        window.__mount = (room, narrow) => {
          const text = ko.chats.composeMovedNotice.replace('{room}', room);
          createRoot(document.getElementById('root')).render(intl(
            React.createElement('div', { id: 'col', className: 'mx-auto flex h-screen flex-col bg-ds-background', style: { width: narrow ? '100%' : '720px' } },
              React.createElement('div', { className: 'flex-1 space-y-3 overflow-hidden p-3' },
                React.createElement('div', { className: 'rounded-ds-panel bg-ds-surface-high px-3 py-2 text-ds-body text-ds-ink' }, '에이전트를 만들었어요 · 이름 MCP Repro · 도구 Claude Code'),
                React.createElement('div', { className: 'ml-auto w-3/4 rounded-ds-panel bg-ds-mine px-3 py-2 text-ds-body text-ds-ink' }, 'reply OK only')),
              React.createElement(ComposeMovedNotice, { text }),
              React.createElement('div', { 'data-testid': 'composer', className: 'm-3 rounded-ds-control border border-ds-line-control bg-ds-surface-sunk px-3 py-3 text-ds-body text-ds-ink' }, '릴리스 점검해 줘'))));
        };`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [layoutStubPlugin()],
  });
  const js = out.outputFiles[0]!.text;
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  const css = (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(tailwindCandidates(js)), { minify: false }).code;
  built = { js, css };
  return built;
}

async function open(page: Page, vp: { width: number; height: number }, room: string, narrow: boolean, dark: boolean) {
  const { js, css } = await build();
  await page.setViewportSize(vp);
  await page.unrouteAll();
  await page.route('http://preview.test/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html lang="ko" class="${dark ? 'dark' : ''}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-ds-background text-ds-ink"><div id="root"></div></body></html>`,
  }));
  const thrown: string[] = [];
  page.on('pageerror', (e) => thrown.push(e.message));
  await page.addInitScript(() => { (window as unknown as { process: unknown }).process = { env: {} }; });
  await page.goto('about:blank');
  await page.goto('http://preview.test/');
  await page.addScriptTag({ content: js });
  await page.evaluate(([r, n]) => (window as unknown as { __mount: (r: string, n: boolean) => void }).__mount(r as string, n as boolean), [room, narrow]);
  await page.waitForTimeout(600);
  if (await page.evaluate(() => document.getElementById('root')!.childElementCount === 0)) throw new Error(`nothing drawn — page errors: ${thrown.join(' | ') || 'none'}`);
}

const measure = (page: Page) => page.evaluate(() => {
  const note = document.querySelector('[data-testid="compose-moved-notice"]') as HTMLElement;
  const banner = note.querySelector('[data-slot="ds-banner"]') as HTMLElement;
  const composer = document.querySelector('[data-testid="composer"]') as HTMLElement;
  const col = document.getElementById('col') as HTMLElement;
  const nb = note.getBoundingClientRect(); const bb = banner.getBoundingClientRect(); const cb = composer.getBoundingClientRect(); const colb = col.getBoundingClientRect();
  const textEl = [...banner.querySelectorAll('div')].find((e) => e.children.length === 0 && (e.textContent || '').length > 20) as HTMLElement;
  const lineH = parseFloat(getComputedStyle(textEl).lineHeight) || 18;
  return {
    text: (textEl.textContent || '').trim(), font: parseFloat(getComputedStyle(textEl).fontSize), lines: Math.round(textEl.getBoundingClientRect().height / lineH),
    noteTop: Math.round(nb.top), noteBottom: Math.round(nb.bottom), composerTop: Math.round(cb.top), gapToComposer: Math.round(cb.top - bb.bottom),
    bannerLeft: Math.round(bb.left), bannerRight: Math.round(bb.right), colLeft: Math.round(colb.left), colRight: Math.round(colb.right), bannerH: Math.round(bb.height),
    overflowX: document.documentElement.scrollWidth > innerWidth + 1, role: banner.getAttribute('role'),
  };
});

const CASES = [
  { name: '1440 × 900', vp: { width: 1440, height: 900 }, narrow: false, touch: false },
  { name: '390 × 844 (phone)', vp: { width: 390, height: 844 }, narrow: true, touch: true },
];
const ROOMS = ['MCP Repro', '결제 연동 · 릴리스 점검 · 오늘 마감 전에 확인할 것 — 아주 긴 방 이름'];

for (const c of CASES) {
  test.describe(c.name, () => {
    test.use({ hasTouch: c.touch, isMobile: c.touch });
    for (const room of ROOMS) {
      for (const dark of [false, true]) {
        test(`[SID:4906] the note names the room «${room.slice(0, 12)}…», stands fully above the composer, nothing runs sideways — ${dark ? 'dark' : 'light'}`, async ({ page }, info) => {
          await open(page, c.vp, room, c.narrow, dark);
          const m = await measure(page);
          expect(m.text, 'the room is named').toContain(room);
          expect(m.role, 'a status, read politely (nothing failed)').toBe('status');
          expect(m.font, 'reading text ≥ 12 px').toBeGreaterThanOrEqual(12);
          expect(m.gapToComposer, 'the note is above the composer, not over it').toBeGreaterThanOrEqual(0);
          expect(m.bannerLeft).toBeGreaterThanOrEqual(m.colLeft);
          expect(m.bannerRight).toBeLessThanOrEqual(m.colRight);
          expect(m.overflowX).toBe(false);
          expect(m.lines, 'at most five lines even with a long room name on a phone').toBeLessThanOrEqual(5);
          const dir = process.env['NOTICE_SHOT_DIR'];
          if (dir) await page.screenshot({ path: path.join(dir, `notice-${c.vp.width}-${room.length > 20 ? 'longname' : 'short'}-${dark ? 'dark' : 'light'}.png`) });
          info.annotations.push({ type: 'numbers', description: JSON.stringify({ lines: m.lines, gap: m.gapToComposer, h: m.bannerH }) });
        });
      }
    }
  });
}
