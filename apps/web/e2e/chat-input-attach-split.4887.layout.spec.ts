/**
 * story 4887 (UI-4 P5-a · AC3 «클립 분할») — the composer's split attach button, measured in Chromium with the REAL `ChatInput` (bundled with esbuild, not copied) and the real Tailwind build of globals.css; only the app shell around it is stubbed.
 * The rule: the clip opens the browser's file window with ONE action — a click, a tap, or one press of Enter or Space on the focused clip — and the ▾ beside it holds the storage picker. jsdom cannot show this (it turns no key press into a click and opens no file window);
 * a real browser's `filechooser` event can. Both controls are also measured against the 24 × 24 px minimum hit target (WCAG 2.5.8): the ▾ is the small one.
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
              React.createElement(ChatInput, { onSend: async () => {}, onUploadFile: async (f) => ({ url: 'u', name: f.name, content_type: f.type, size: f.size }), threadId: 't1', projectId: 'p1', currentTeamMemberId: 'me-1', participants: [{ member_id: 'me-1', name: '나' }, { member_id: 'a-1', name: '개발 에이전트' }] }))));
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
  await page.setViewportSize({ width, height: 700 });
  await page.unrouteAll();
  await page.route('http://preview.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body style="margin:0"><div id="root"></div></body></html>` });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [] }) });
  });
  await page.goto('about:blank');
  await page.goto('http://preview.test/');
  await page.addScriptTag({ content: js });
  await page.evaluate(() => (window as unknown as { __mount: () => void }).__mount());
  await page.getByTestId('chat-attach-upload').waitFor();
}

const CLIP = '[data-testid="chat-attach-upload"]';
const MORE = '[data-testid="chat-attach-more"]';

/**
 * What «opens the file window» means for the PRODUCT: the clip makes the hidden file input receive ONE click, inside a live user activation (Chromium shows a file window only for a click made with one). That is recorded IN THE PAGE (a capturing listener on the input), so it does not depend on the harness:
 * Playwright arms its `filechooser` interception asynchronously, and a fast key sequence can beat the arming — one run of CI saw the Space test time out while the SAME code passed in the next run and in a diagnostic that pressed Space five ways on Linux headless Chromium
 * (key down → key press → key up → click, activation alive, the window opens every time). The end-to-end `filechooser` event is kept for ONE test (the mouse click), armed before the click.
 */
async function recordInputClicks(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __clicks: { trusted: boolean; active: boolean }[]; __seq: string[] };
    w.__clicks = []; w.__seq = [];
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    const clip = document.querySelector('[data-testid="chat-attach-upload"]') as HTMLElement;
    const active = () => !!(navigator as unknown as { userActivation?: { isActive: boolean } }).userActivation?.isActive;
    input.addEventListener('click', (e) => { w.__clicks.push({ trusted: e.isTrusted, active: active() }); w.__seq.push('input-click'); }, true);
    for (const t of ['keydown', 'keyup', 'click']) clip.addEventListener(t, () => w.__seq.push(t), true);
  });
}
const inputClicks = (page: Page) => page.evaluate(() => (window as unknown as { __clicks: { trusted: boolean; active: boolean }[] }).__clicks);
const sequence = (page: Page) => page.evaluate(() => (window as unknown as { __seq: string[] }).__seq);

test('[SID:4887] one click on the clip opens the browser\'s file window (the end-to-end proof: the real filechooser event)', async ({ page }) => {
  await open(page, 1100);
  const armed = page.waitForEvent('filechooser', { timeout: 5000 }); // armed BEFORE the click
  await page.evaluate(() => null); // a round trip after arming, so the click cannot beat it
  await page.click(CLIP); // reverted (the clip opens a menu) → no chooser: this times out
  const chooser = await armed;
  expect(chooser.isMultiple(), 'the picker takes several files, as before').toBe(true);
});

test('[SID:4887] one click on the clip: the file input gets exactly ONE click, inside a live user activation — and no menu opens', async ({ page }) => {
  await open(page, 1100); await recordInputClicks(page);
  await page.click(CLIP);
  await expect.poll(async () => (await inputClicks(page)).length, { message: 'the clip clicked the file input' }).toBe(1); // reverted (the clip opens a menu) → stays 0
  expect((await inputClicks(page))[0]!.active, 'a user activation was alive at that click — what lets the window open').toBe(true);
  expect(await page.locator('[role=menu]').count(), 'no menu between the clip and the window').toBe(0);
});

for (const key of ['Enter', 'Space']) {
  test(`[SID:4887] ONE press of ${key} on the focused clip makes the file input get ONE click inside a live user activation — the keyboard is as short as the mouse`, async ({ page }) => {
    await open(page, 1100); await recordInputClicks(page);
    await page.focus(CLIP);
    await page.keyboard.press(key);
    await expect.poll(async () => (await inputClicks(page)).length, { message: `${key} on the clip clicked the file input` }).toBe(1);
    const click = (await inputClicks(page))[0]!;
    expect(click.active, 'a user activation was alive at that click').toBe(true);
    const seq = await sequence(page);
    expect(seq.filter((e) => e === 'input-click'), 'exactly one input click — not two').toHaveLength(1);
    // a native button: Enter clicks on key DOWN, Space on key UP (Chromium, every platform) — the order is the browser's, and it is what makes Space work
    if (key === 'Space') expect(seq.indexOf('keyup')).toBeLessThan(seq.indexOf('click'));
    else expect(seq.indexOf('click')).toBeLessThan(seq.indexOf('keyup'));
  });
}

test.describe('on a touch screen', () => {
  test.use({ hasTouch: true, isMobile: true });
  test('[SID:4887] one TAP on the clip makes the file input get ONE click inside a live user activation', async ({ page }) => {
    await open(page, 390); await recordInputClicks(page);
    await page.tap(CLIP);
    await expect.poll(async () => (await inputClicks(page)).length, { message: 'the tap clicked the file input' }).toBe(1);
    expect((await inputClicks(page))[0]!.active, 'a user activation was alive at that click').toBe(true);
  });

  test('[SID:4887] on a touch screen BOTH halves of the split are at least 44 × 44 px (the ds convention for a coarse pointer — the composer is the most tapped place on a phone), side by side on one centre line, and the composer row does not run past a 320 px screen', async ({ page }) => {
    await open(page, 320);
    const clip = (await page.locator(CLIP).boundingBox())!;
    const more = (await page.locator(MORE).boundingBox())!;
    for (const [name, b] of [['the clip', clip], ['the ▾', more]] as const) {
      expect(b.width, `${name} is at least 44 px wide on touch (${Math.round(b.width)})`).toBeGreaterThanOrEqual(44); // reverted (no coarse-pointer width on the ▾) → ~26
      expect(b.height, `${name} is at least 44 px tall on touch (${Math.round(b.height)})`).toBeGreaterThanOrEqual(44);
    }
    expect(Math.abs((clip.y + clip.height / 2) - (more.y + more.height / 2)), 'the two halves share a centre line').toBeLessThanOrEqual(2);
    expect(more.x - (clip.x + clip.width), 'no gap between them').toBeLessThanOrEqual(1);
    // the ▾'s icon sits in the MIDDLE of its 44 px box (a finger aims at the middle)
    const icon = (await page.locator(`${MORE} svg`).boundingBox())!;
    expect(Math.abs((icon.x + icon.width / 2) - (more.x + more.width / 2)), 'the ▾ icon is centred in its box').toBeLessThanOrEqual(2);
    const w = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(w.scroll, 'no horizontal overflow at 320 px on touch').toBeLessThanOrEqual(w.client);
    // the tightest row: clip + ▾ (88 px on touch) + the steer compass + the send button leave the text box a usable width (measured ≈ 104 px in this harness, ≈ 120 px in the app)
    const box = (await page.locator('textarea[data-slot="textarea"]').boundingBox())!;
    expect(box.width, `the text box keeps a usable width at 320 px on touch (${Math.round(box.width)})`).toBeGreaterThanOrEqual(96); // reverted (wider controls) → narrower
  });
});

test('[SID:4887] both controls are at least 24 × 24 px (WCAG 2.5.8) — the ▾ is the small one — and sit side by side without a gap that swallows a tap', async ({ page }) => {
  await open(page, 390);
  const clip = (await page.locator(CLIP).boundingBox())!;
  const more = (await page.locator(MORE).boundingBox())!;
  for (const [name, b] of [['the clip', clip], ['the ▾', more]] as const) {
    expect(b.width, `${name} is at least 24 px wide (${Math.round(b.width)})`).toBeGreaterThanOrEqual(24); // reverted (px-1 → a 22 px ▾) → fails
    expect(b.height, `${name} is at least 24 px tall (${Math.round(b.height)})`).toBeGreaterThanOrEqual(24);
  }
  expect(more.x - (clip.x + clip.width), 'the ▾ touches the clip: no dead gap between').toBeLessThanOrEqual(1);
});

test('[SID:4887] the ▾ opens a menu with the storage picker only — the upload is the clip', async ({ page }) => {
  await open(page, 1100);
  await page.click(MORE);
  await page.locator('[role=menuitem]').first().waitFor({ timeout: 3000 }); // the popup is a portal: wait for it before counting
  const items = await page.locator('[role=menuitem]').allTextContents();
  expect(items.map((s) => s.trim())).toEqual(['스토리지에서 선택']);
});

test('[SID:4887] at 320 px the composer\'s row does not run past the screen', async ({ page }) => {
  await open(page, 320);
  const w = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(w.scroll).toBeLessThanOrEqual(w.client);
});
