/**
 * story 4855 — on a touch device the message's menu is opened by a «⋯» button (a long press on the text belongs to the platform's text selection). The button sits beside the
 * message's time line. PO's condition: it must not cover or push the time line at phone width.
 *
 * Layout is the browser's job (jsdom computes none), so this runs in Chromium: the meta cell is built with the component's OWN class strings read from chat-bubble.tsx and the real
 * Tailwind build of globals.css. «Touch» is Chromium's mobile emulation (`pointer: coarse`); the same cell is also measured with a mouse (the button is not drawn there).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Browser } from '@playwright/test';
import { compile, optimize } from '@tailwindcss/node';

const BUBBLE = path.join(__dirname, '../src/components/chat/chat-bubble.tsx');
const APP = path.join(__dirname, '../src/app');

/** the class strings of the column, the bubble text, the time and the «⋯» button (drift-proof: read from the source, not copied) */
function classesFromSource() {
  const src = readFileSync(BUBBLE, 'utf8');
  const pick = (re: RegExp, what: string) => { const m = re.exec(src); if (!m) throw new Error(`${what} not found`); return m[1]!; };
  const button = pick(/data-testid="chat-bubble-menu-button"[\s\S]*?className=\{`([^`]+)`\}/, 'the menu button className');
  return {
    column: pick(/<div (?:data-chat-content="" )?className=\{`(flex min-w-0 max-w-\[72%\] flex-col gap-0\.5 )\$\{isMine/, 'the message column'),
    text: pick(/<div data-testid="chat-bubble-text" className=\{`([^$`]+)\$\{/, 'the bubble text box').trim(),
    time: pick(/<time className="([^"]+)" dateTime/, 'the time'),
    wrap: pick(/<span (?:data-chat-meta="" )?className="(relative inline-block)">\s*<time/, 'the time wrapper'),
    buttonBase: button.replace(/\$\{[^}]*\}/, '').trim(),
    mine: pick(/\$\{isMine \? '([^']+)' : '[^']+'\}`\}\s*>\s*<MoreHorizontal/, 'the button side (mine)'),
    theirs: pick(/\$\{isMine \? '[^']+' : '([^']+)'\}`\}\s*>\s*<MoreHorizontal/, 'the button side (others)'),
  };
}

async function css(classes: string[]): Promise<string> {
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  return (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(classes), { minify: false }).code;
}

type Box = { x: number; y: number; width: number; height: number };

async function measure(browser: Browser, width: number, touch: boolean, mine: boolean) {
  const c = classesFromSource();
  const classes = [c.column, 'items-end', 'items-start', c.text, c.time, c.wrap, c.buttonBase, c.mine, c.theirs, 'flex gap-2 flex-row-reverse flex-row', 'h-7 w-7 flex-shrink-0 rounded-full bg-info/15']
    .join(' ').split(/\s+/).filter(Boolean);
  const context = await browser.newContext(touch ? { viewport: { width, height: 800 }, hasTouch: true, isMobile: true } : { viewport: { width, height: 800 } });
  const page = await context.newPage();
  const side = mine ? c.mine : c.theirs;
  await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${await css(classes)}</style></head><body style="margin:0">
    <div style="padding:8px">
      <div id="row" class="flex gap-2 ${mine ? 'flex-row-reverse' : 'flex-row'}">
        <div id="avatar" class="h-7 w-7 flex-shrink-0 rounded-full bg-info/15"></div>
        <div id="col" class="${c.column}${mine ? 'items-end' : 'items-start'}">
          <div id="text" class="${c.text}">짧은 글</div>
          <span class="${c.wrap}"><time id="time" class="${c.time}">오전 07:32</time><button id="menu" type="button" class="${c.buttonBase} ${side}">⋯</button></span>
        </div>
      </div>
      <div id="below" style="height:20px">next message</div>
    </div></body></html>`);
  const box = async (sel: string) => (await page.locator(sel).boundingBox()) as Box;
  const out = {
    time: await box('#time'),
    avatar: await box('#avatar'),
    text: await box('#text'),
    col: await box('#col'),
    below: await box('#below'),
    menuShown: await page.locator('#menu').isVisible(),
    menu: (await page.locator('#menu').isVisible()) ? await box('#menu') : null,
    scrollW: await page.evaluate(() => document.documentElement.scrollWidth),
    clientW: await page.evaluate(() => document.documentElement.clientWidth),
  };
  await context.close();
  return out;
}

const intersects = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

for (const width of [360, 411]) {
  for (const mine of [false, true]) {
    test(`[SID:4855] ${width}px ${mine ? 'my' : 'their'} message: on touch the «⋯» button is drawn, does not cover the time, does not push it, and stays on the screen`, async ({ browser }) => {
      const mouse = await measure(browser, width, false, mine);
      const touch = await measure(browser, width, true, mine);
      expect(mouse.menuShown, 'a mouse never sees the button').toBe(false);
      expect(touch.menuShown, 'a touch device sees the button').toBe(true);
      // does not push: the time and the cell are where they were without the button
      expect(touch.time.x).toBeCloseTo(mouse.time.x, 0);
      expect(touch.time.y).toBeCloseTo(mouse.time.y, 0);
      expect(touch.col.height).toBeCloseTo(mouse.col.height, 0);
      expect(touch.below.y).toBeCloseTo(mouse.below.y, 0);
      // does not cover: the two boxes do not meet
      expect(intersects(touch.menu!, touch.time), 'the button does not sit on the time line').toBe(false);
      // does not sit on the sender's avatar (a press on the avatar must stay the avatar's)
      expect(intersects(touch.menu!, touch.avatar), 'the button does not sit on the avatar').toBe(false);
      // does not cover the message text: the touch target may reach into the bubble's bottom padding (py-2 = 8px) but not onto the text line
      expect(touch.menu!.y, 'the button stays off the text of the bubble').toBeGreaterThanOrEqual(touch.text.y + touch.text.height - 8);
      // stays on the screen and does not make the page scroll sideways
      expect(touch.menu!.x).toBeGreaterThanOrEqual(0);
      expect(touch.menu!.x + touch.menu!.width).toBeLessThanOrEqual(width);
      expect(touch.scrollW).toBeLessThanOrEqual(touch.clientW);
      // a thumb-sized target
      expect(touch.menu!.width).toBeGreaterThanOrEqual(32);
      expect(touch.menu!.height).toBeGreaterThanOrEqual(32);
    });
  }
}
