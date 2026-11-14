/**
 * story 4906 (Yuna, lap 3) — where the TEXT sits in the chat room's input, measured in Chromium with the REAL `ChatInput` (bundled with esbuild) and the real Tailwind build of globals.css.
 * On a phone (< 640 px) the text is written from the LEFT at the TOP of the box: the field takes the whole first row and the clip · ▾ · compass row sits UNDER it, the send button at the right end. (It sat to the right of the three
 * 44 px buttons — a third of the box — so a short line looked centered, and top-aligned when the field was a line taller than its text.) From 640 px up the one row is as it was: the buttons left of the field.
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
        import React from 'react'; import { createRoot } from 'react-dom/client'; import { NextIntlClientProvider } from 'next-intl';
        import ko from './messages/ko.json';
        import { ChatInput } from './src/components/chat/chat-input';
        window.__mount = () => {
          createRoot(document.getElementById('root')).render(React.createElement(NextIntlClientProvider, { locale: 'ko', messages: ko, timeZone: 'Asia/Seoul' },
            React.createElement('div', { id: 'composer', style: { width: '100%', padding: '8px' } },
              React.createElement(ChatInput, { onSend: async (t) => { (window.__sent = window.__sent || []).push(t); }, onUploadFile: async (f) => ({ url: 'u', name: f.name, content_type: f.type, size: f.size }), threadId: 't1', projectId: 'p1', currentTeamMemberId: 'me-1', participants: [{ member_id: 'me-1', name: '나' }, { member_id: 'a-1', name: '개발 에이전트' }] }))));
        };`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_APP_URL': '"https://app.sprintable.ai"' },
    plugins: [layoutStubPlugin()],
  });
  const js = out.outputFiles[0]!.text;
  // the quoted strings AND the template literals (the composer box's classes are in a template literal — Tailwind's own scan reads both)
  const candidates = [...new Set([...js.matchAll(/"([^"\n]+)"/g), ...js.matchAll(/`([^`]+)`/g)].flatMap((m) => m[1]!.split(/\s+/)).filter((c) => c && !c.includes('${') && !c.includes('}')))];
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  const css = (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(candidates), { minify: false }).code;
  built = { js, css };
  return built;
}

let dark = false;
async function open(page: Page, width: number, opts?: { dark?: boolean }) {
  dark = Boolean(opts?.dark);
  const { js, css } = await build();
  await page.setViewportSize({ width, height: 700 });
  await page.unrouteAll();
  await page.route('http://preview.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ko" class="${dark ? 'dark' : ''}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body style="margin:0"><div id="root"></div></body></html>` });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [] }) });
  });
  await page.goto('about:blank');
  await page.goto('http://preview.test/');
  await page.addScriptTag({ content: js });
  await page.evaluate(() => (window as unknown as { __mount: () => void }).__mount());
  await page.getByTestId('chat-attach-upload').waitFor();
}


const BOX = '[data-testid="chat-composer-box"]';
const TA = 'textarea[data-slot="textarea"]';
async function geometry(page: Page) {
  return page.evaluate(({ box, ta }) => {
    const r = (el: Element | null) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
    const area = document.querySelector(ta) as HTMLTextAreaElement;
    return {
      box: r(document.querySelector(box)), ta: r(area), padL: parseFloat(getComputedStyle(area).paddingLeft), textAlign: getComputedStyle(area).textAlign,
      clip: r(document.querySelector('[data-testid="chat-attach-upload"]')), more: r(document.querySelector('[data-testid="chat-attach-more"]')), send: r(document.querySelector('[data-testid="chat-send"]')),
    };
  }, { box: BOX, ta: TA });
}

for (const width of [320, 360, 390, 639]) {
  test(`[SID:4906] phone ${width}: the text is written from the left at the TOP of the box — the field is the whole first row, the buttons sit under it, send at the right end`, async ({ page }) => {
    await open(page, width);
    await page.locator(TA).fill('첫 글 — 방 시험');
    const g = await geometry(page);
    const box = g.box!; const ta = g.ta!; const clip = g.clip!; const send = g.send!;
    expect(g.textAlign, 'the field aligns its text to the start').toBe('start');
    expect(ta.x - box.x, 'the field starts at the box\'s left edge (the text starts ≤ 14 px in)').toBeLessThanOrEqual(10);
    expect(ta.x + g.padL - box.x, 'the first letter is within 14 px of the box edge').toBeLessThanOrEqual(14);
    expect(box.r - ta.r, 'and runs to the right edge: the whole first row').toBeLessThanOrEqual(10);
    expect(ta.b, 'the buttons are UNDER the field').toBeLessThanOrEqual(clip.y + 1);
    expect(clip.x - box.x, 'the clip is at the left of the second row').toBeLessThanOrEqual(10);
    expect(box.r - send.r, 'send is at the right end of the second row').toBeLessThanOrEqual(10);
    expect(send.y, 'send is on the second row').toBeGreaterThanOrEqual(ta.b - 1);
    expect(Math.abs((send.y + send.h / 2) - (clip.y + clip.h / 2)), 'send is on the SAME row as the clip (not a third row)').toBeLessThan(6);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    expect(overflow, 'no sideways scroll').toBe(false);
  });
}

for (const width of [640, 1100, 1440]) {
  test(`[SID:4906] ${width}: the one row as before — the buttons left of the field, the send button right of it, all on one line`, async ({ page }) => {
    await open(page, width);
    await page.locator(TA).fill('첫 글 — 방 시험');
    const g = await geometry(page);
    const ta = g.ta!; const clip = g.clip!; const send = g.send!;
    expect(ta.x, 'the field is right of the clip and the ▾').toBeGreaterThan(g.more!.r - 1);
    expect(Math.abs((ta.y + ta.h / 2) - (clip.y + clip.h / 2)), 'one line').toBeLessThan(ta.h);
    expect(send.x, 'send is right of the field').toBeGreaterThan(ta.r - 1);
  });
}

// what the second row must still be, and what the keys still do (the change is CSS only: nothing of this may move)
test.describe('a touch phone', () => {
  test.use({ hasTouch: true, isMobile: true });
  for (const width of [320, 360, 390]) {
    test(`[SID:4906] ${width}: every press in the composer — the clip · ▾ · compass and send — is still at least 44 × 44, and all four sit on ONE row under the field`, async ({ page }) => {
      await open(page, width);
      const sizes = await page.evaluate((box) => [...document.querySelector(box)!.querySelectorAll('button')].map((b) => { const r = b.getBoundingClientRect(); return { label: b.getAttribute('aria-label') || b.getAttribute('data-testid') || b.textContent!.trim(), w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10, y: Math.round(r.top) }; }).filter((b) => b.w > 0), BOX);
      expect(sizes.length, 'clip · ▾ · compass · send').toBeGreaterThanOrEqual(4);
      expect(sizes.filter((b) => b.w < 43.5 || b.h < 43.5), `presses under 44 px: ${JSON.stringify(sizes)}`).toEqual([]);
      const ys = sizes.map((b) => b.y);
      expect(Math.max(...ys) - Math.min(...ys), `one row, not a third: ${JSON.stringify(sizes)}`).toBeLessThan(6);
      const g = await geometry(page);
      expect(Math.min(...ys), 'under the field').toBeGreaterThanOrEqual(g.ta!.b - 1);
    });
  }
  test('[SID:4906] on a touch screen Enter is a new line and only the send button sends', async ({ page }) => {
    await open(page, 390);
    await page.locator(TA).fill('줄 하나');
    await page.locator(TA).press('Enter');
    await page.keyboard.type('줄 둘');
    expect(await page.locator(TA).inputValue()).toBe('줄 하나\n줄 둘');
    expect(await page.evaluate(() => (window as unknown as { __sent?: string[] }).__sent ?? [])).toEqual([]);
    await page.getByTestId('chat-send').tap();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __sent?: string[] }).__sent ?? [])).toEqual(['줄 하나\n줄 둘']);
  });
});

test.describe('a 390 px window with a mouse and a keyboard', () => {
  test('[SID:4906] Enter sends · Shift+Enter breaks the line · the field grows with the text up to 160 px and no further', async ({ page }) => {
    await open(page, 390);
    const ta = page.locator(TA);
    await ta.fill('첫 줄');
    await ta.press('Shift+Enter');
    await page.keyboard.type('둘째 줄');
    expect(await ta.inputValue()).toBe('첫 줄\n둘째 줄');
    expect(await page.evaluate(() => (window as unknown as { __sent?: string[] }).__sent ?? [])).toEqual([]);
    await ta.press('Enter');
    await expect.poll(() => page.evaluate(() => (window as unknown as { __sent?: string[] }).__sent ?? [])).toEqual(['첫 줄\n둘째 줄']);
    const short = (await geometry(page)).ta!.h;
    await ta.fill(Array.from({ length: 14 }, (_, i) => `줄 ${i + 1}`).join('\n'));
    const tall = await geometry(page);
    expect(tall.ta!.h, 'it grew').toBeGreaterThan(short);
    expect(tall.ta!.h, 'and stops at 160').toBeLessThanOrEqual(160.5);
    expect(tall.clip!.y, 'the buttons stay under the field').toBeGreaterThanOrEqual(tall.ta!.b - 1);
  });
});

test('[SID:4906] dark: the same two rows (text top-left, buttons under it)', async ({ page }) => {
  await open(page, 390, { dark: true });
  await page.locator(TA).fill('첫 글 — 방 시험');
  const g = await geometry(page);
  expect(g.ta!.x - g.box!.x).toBeLessThanOrEqual(10);
  expect(g.ta!.b).toBeLessThanOrEqual(g.clip!.y + 1);
  expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(true);
});

test('[SID:4906] right-to-left: send goes to the row\'s END (the left edge), not next to the compass — the offset is logical', async ({ page }) => {
  await open(page, 390);
  await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
  const g = await geometry(page);
  expect(g.send!.x - g.box!.x, 'send is at the left end of the second row').toBeLessThanOrEqual(10);
  expect(g.box!.r - g.clip!.r, 'the clip is at the right of the second row').toBeLessThanOrEqual(10);
});
