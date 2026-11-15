/**
 * story 4853 (phone · point 1) — on the phone app the round support button floats over the chat list and hid the time of the row under it («17 minutes ago» → «17 minu…»).
 * While the button is drawn, support-widget-launcher.tsx puts `data-support-launcher` on <html>; the chat list's row (ConversationRow in chat-list-view.tsx) reads it with a
 * CSS variant and keeps its right side clear of the button at phone width (< md).
 *
 * Layout is the browser's job (jsdom computes none), so this runs in Chromium: the row is built with the component's OWN class strings, read from chat-list-view.tsx, and the real
 * Tailwind build of globals.css for them; the button is the launcher's own class string with its real size. No server (the page is set directly).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { compile, optimize } from '@tailwindcss/node';

const LIST = path.join(__dirname, '../src/components/chat/chat-list-view.tsx');
const LAUNCHER = path.join(__dirname, '../src/components/support-widget/support-widget-launcher.tsx');
const APP = path.join(__dirname, '../src/app');

/** the class strings the list row and the launcher render (drift-proof: read from the source, not copied) */
function classesFromSource() {
  const list = readFileSync(LIST, 'utf8');
  const launcher = readFileSync(LAUNCHER, 'utf8');
  const pick = (src: string, re: RegExp, what: string) => { const m = re.exec(src); if (!m) throw new Error(`${what} not found`); return m[1]!; };
  return {
    row: pick(list, /className="([^"]*data-support-launcher[^"]*)"/, 'the ConversationRow className with the launcher variant'),
    title: pick(list, /<span className="([^"]+)">\{displayName\}<\/span>/, 'the row title'),
    time: pick(list, /<span className="([^"]+)">\{formatTime\(time, locale, displayTimezone\)\}<\/span>/, 'the row time'),
    // story 4887 (UI-4 P2-b) — the unread count sits on the TITLE line, in one right-hand cluster with the time (the badge span carries a data-testid after its className)
    cluster: pick(list, /<span className="([^"]+)">\s*<span className="[^"]+">\{formatTime\(time, locale, displayTimezone\)\}<\/span>/, 'the right-hand cluster of the title line'),
    badge: pick(list, /\{unread > 0 && \(\s*<span className="([^"]+)"[^>]*>/, 'the unread badge'),
    preview: pick(list, /<p className="([^"]+)">\{preview\}<\/p>/, 'the preview'),
    button: pick(launcher, /className="(pointer-events-auto flex h-12 w-12[^"]*)"/, 'the launcher button'),
    attr: pick(launcher, /SUPPORT_LAUNCHER_ATTR = '([^']+)'/, 'the launcher attribute'),
  };
}

async function css(classes: string[]): Promise<string> {
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  return (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(classes), { minify: false }).code;
}

type Box = { x: number; y: number; width: number; height: number };

/** one row under the round button (the button is put over the row's middle, as on the phone: right edge ~14px from the screen, 48px) */
async function measure(page: import('@playwright/test').Page, width: number, withAttr: boolean) {
  const c = classesFromSource();
  const all = [c.row, c.title, c.time, c.cluster, c.badge, c.preview, c.button, 'h-9 w-9 flex-shrink-0 rounded-full bg-info/15', 'min-w-0 flex-1', 'flex items-center justify-between gap-1', 'truncate text-xs text-muted-foreground']
    .join(' ').split(/\s+/).filter(Boolean);
  await page.setViewportSize({ width, height: 800 });
  await page.setContent(`<!doctype html><html><head><style>${await css(all)}</style></head><body style="margin:0">
    <div style="padding:0 8px;padding-top:300px">
      <button id="row" type="button" class="${c.row}" style="display:flex">
        <div class="h-9 w-9 flex-shrink-0 rounded-full bg-info/15"></div>
        <div class="min-w-0 flex-1">
          <div class="flex items-center justify-between gap-1"><span id="title" class="${c.title}">긴 방 이름이 들어가는 한 줄 — 프로젝트 이름과 함께 길어지는 경우</span><span class="${c.cluster}"><span id="time" class="${c.time}">17 minutes ago</span><span id="badge" class="${c.badge}">3</span></span></div>
          <p class="${c.preview}">No messages</p>
        </div>
      </button>
    </div>
    <button id="launcher" type="button" class="${c.button}" style="position:fixed;right:14px;top:0">?</button></body></html>`);
  if (withAttr) await page.evaluate((a) => document.documentElement.setAttribute(a, ''), c.attr);
  const box = async (sel: string) => (await page.locator(sel).boundingBox()) as Box;
  const row = await box('#row');
  // the button over the middle of the row
  await page.evaluate((top) => { (document.getElementById('launcher') as HTMLElement).style.top = `${top}px`; }, row.y + row.height / 2 - 24);
  return { time: await box('#time'), badge: await box('#badge'), title: await box('#title'), button: await box('#launcher'), row: await box('#row') };
}

test('[SID:4853] phone width + the launcher drawn: the time and the unread badge of a row end before the round button', async ({ page }) => {
  const m = await measure(page, 411, true);
  expect(m.time.x + m.time.width, 'the time ends left of the button').toBeLessThanOrEqual(m.button.x - 4);
  expect(m.badge.x + m.badge.width, 'the unread badge ends left of the button').toBeLessThanOrEqual(m.button.x - 4);
  expect(m.title.width, 'the title keeps room').toBeGreaterThan(40);
});

test('[SID:4853] the same row without the mark (onboarding finished · the button is not drawn): the time sits where it did — and it WOULD be under the button (the failure the gutter fixes)', async ({ page }) => {
  const without = await measure(page, 411, false);
  expect(without.time.x + without.time.width, 'without the gutter the time reaches under the button').toBeGreaterThan(without.button.x);
  const withAttr = await measure(page, 411, true);
  expect(withAttr.time.x + withAttr.time.width).toBeLessThan(without.time.x + without.time.width);
  // the gutter is on the right only: the row's left side does not move
  expect(withAttr.title.x).toBeCloseTo(without.title.x, 0);
});

test('[SID:4853] from md up (the list is a side rail, the button is far from it): the mark changes nothing', async ({ page }) => {
  const without = await measure(page, 1024, false);
  const withAttr = await measure(page, 1024, true);
  expect(withAttr.time.x + withAttr.time.width).toBeCloseTo(without.time.x + without.time.width, 0);
  expect(withAttr.row.width).toBeCloseTo(without.row.width, 0);
});
