/**
 * story 4887 (UI-4 P6-a · AC3 «답글 아이콘 상시») — the reply control, measured in Chromium with the component's OWN class strings (read from chat-bubble.tsx) and the real Tailwind build of globals.css, inside a list shaped like the real one (px-4, overflow-y-auto, gap-3 rows).
 * The rule: the first reply used to sit behind a right-click / «⋯» menu. A MOUSE gets a button beside the bubble that appears with the row's hover or keyboard focus; a TOUCH screen gets a 44 × 44 button in the time line right beside «⋯», always shown — neither shrinks the bubble,
 * runs past the screen, or reaches into the neighbouring message, and the continuation's hover time never meets the mouse button.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Browser } from '@playwright/test';
import { compile, optimize } from '@tailwindcss/node';
import { bubbleVariants } from './bubble-variants';

const BUBBLE = path.join(__dirname, '../src/components/chat/chat-bubble.tsx');
const APP = path.join(__dirname, '../src/app');

function classesFromSource() {
  const src = readFileSync(BUBBLE, 'utf8');
  const pick = (re: RegExp, what: string, i = 1) => { const m = re.exec(src); if (!m) throw new Error(`${what} not found`); return m[i]!; };
  const cont = /\? \(isMine(?: && !plainRow)?\s*\? '([^']+)'\s*: '([^']+)'\)/.exec(src);
  if (!cont) throw new Error('the continuation time line classes not found');
  const reply = /data-testid="chat-bubble-reply-button"[\s\S]*?className=\{`([^`$]+)\$\{isMine(?: && !plainRow)? \? '([^']+)' : '([^']+)'\}`\}/.exec(src);
  if (!reply) throw new Error('the reply button classes not found');
  const replyT = /data-testid="chat-bubble-reply-button-touch"[\s\S]*?className=\{`([^`$]+)\$\{isMine(?: && !plainRow)? \? '([^']+)' : '([^']+)'\}`\}/.exec(src);
  if (!replyT) throw new Error('the touch reply button classes not found');
  const more = /data-testid="chat-bubble-menu-button"[\s\S]*?className=\{`([^`$]+)\$\{isMine(?: && !plainRow)? \? '([^']+)' : '([^']+)'\}`\}/.exec(src);
  if (!more) throw new Error('the «⋯» button classes not found');
  const text = /<div data-testid="chat-bubble-text" className=\{`([^$`]+)\$\{/.exec(src);
  const tern = bubbleVariants(src);
  if (!text || !tern) throw new Error('the bubble text classes not found');
  return {
    row: pick(/className=\{`(group\/bubble flex scroll-mt-4 gap-2 transition-shadow )\$\{isMine/, 'the row'),
    column: pick(/<div (?:data-chat-content="" )?className=\{`((?:relative )?flex min-w-0 max-w-\[72%\] (?:\S+ )*?flex-col gap-0\.5 )\$\{isMine/, 'the message column'),
    textBase: text[1]!.trim(), textMine: tern.mine, textPerson: tern.person,
    metaTime: pick(/<time className="([^"]+)" dateTime=\{message\.created_at\}><ViewerDate/, 'the meta time'),
    contMine: cont[1]!, contTheirs: cont[2]!,
    replyBase: reply[1]!.trim(), replyMine: reply[2]!, replyTheirs: reply[3]!,
    moreBase: more[1]!.trim(), moreMine: more[2]!, moreTheirs: more[3]!,
    replyTBase: replyT[1]!.trim(), replyTMine: replyT[2]!, replyTTheirs: replyT[3]!,
  };
}

async function css(classes: string[]): Promise<string> {
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  return (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(classes), { minify: false }).code;
}


type Box = { x: number; y: number; width: number; height: number };
const LONG = '이 글은 말풍선이 가질 수 있는 가장 넓은 폭까지 줄을 바꿔 가며 길게 이어지는 글입니다 — 폭이 줄었는지를 재려고 일부러 길게 씁니다. '.repeat(3);

/** the list the rows sit in (px-4 · overflow-y-auto · gap-3 — the real chat list); each row: the avatar gutter · the column (the mouse twin) · the bubble text · the time line (time · «⋯» · the touch twin). rows = 2 puts a SECOND same-sender row right under the first (the grouped row's mt-0.5). */
async function scene(browser: Browser, o: { touch: boolean; mine: boolean; width: number; withReply: boolean; withMenu?: boolean; continuation?: boolean; text?: string; rows?: 1 | 2 }) {
  const c = classesFromSource();
  const side = o.mine ? 'items-end' : 'items-start';
  const textCls = `${c.textBase} ${o.mine ? c.textMine : c.textPerson}`;
  const meta = o.continuation ? (o.mine ? c.contMine : c.contTheirs) : 'relative inline-block [@media(pointer:fine)_and_(hover:hover)]:hidden';
  const replyCls = `${c.replyBase} ${o.mine ? c.replyMine : c.replyTheirs}`;
  const replyTCls = `${c.replyTBase} ${o.mine ? c.replyTMine : c.replyTTheirs}`;
  const moreCls = `${c.moreBase} ${o.mine ? c.moreMine : c.moreTheirs}`;
  const all = [c.row, c.column, textCls, c.metaTime, meta, replyCls, replyTCls, moreCls, 'flex-row-reverse flex-row', 'items-end items-start', 'h-7 w-7 flex-shrink-0 rounded-full bg-info/15', 'w-7 flex-shrink-0', 'flex flex-col gap-3 mt-0.5'].join(' ').split(/\s+/).filter(Boolean);
  const context = await browser.newContext(o.touch ? { viewport: { width: o.width, height: 700 }, hasTouch: true, isMobile: true } : { viewport: { width: o.width, height: 700 } });
  const page = await context.newPage();
  const icon = '<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/></svg>';
  const row = (n: '' | '2') => `<div id="row${n}" class="${c.row}${o.mine ? 'flex-row-reverse' : 'flex-row'}${n ? ' mt-0.5' : ''}">
        ${o.continuation || n ? '<div class="w-7 flex-shrink-0"></div>' : '<div class="h-7 w-7 flex-shrink-0 rounded-full bg-info/15"></div>'}
        <div id="col${n}" class="${c.column}${side}"${o.withReply ? ' style="--reply-cap:128px"' : ''}>
          ${o.withReply ? `<button id="reply${n}" type="button" aria-label="reply" class="${replyCls}">${icon}</button>` : ''}
          <div id="text${n}" class="${textCls}">${o.text ?? '짧은 글'} <a id="link${n}" href="#x">링크</a></div>
          <span id="meta${n}" class="${meta}"${o.withReply ? ' style="--reply-room:36px"' : ''}><time id="time${n}" class="${c.metaTime}">오전 07:33</time>${o.withMenu ? `<button id="more${n}" type="button" aria-label="more" class="${moreCls}">${icon}</button>` : ''}${o.withReply && o.withMenu ? `<button id="replyT${n}" type="button" aria-label="reply (touch)" class="${replyTCls}">${icon}</button>` : ''}</span>
        </div>
      </div>`;
  await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${await css(all)}</style></head><body style="margin:0">
    <div id="list" class="flex flex-col gap-3" style="padding:12px 16px;overflow-y:auto;height:640px">
      ${row('')}${o.rows === 2 ? row('2') : ''}
      <div id="below" style="height:20px">next message</div>
    </div></body></html>`);
  const box = async (sel: string) => (await page.locator(sel).boundingBox()) as Box | null;
  const opacity = (sel: string) => page.locator(sel).evaluate((e) => Number(getComputedStyle(e).opacity));
  const display = (sel: string) => page.locator(sel).evaluate((e) => getComputedStyle(e).display);
  const listOverflow = () => page.evaluate(() => { const l = document.getElementById('list')!; return { scroll: l.scrollWidth, client: l.clientWidth, docScroll: document.documentElement.scrollWidth, docClient: document.documentElement.clientWidth }; });
  return { page, context, box, opacity, display, listOverflow };
}

/** two boxes share area */
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

for (const mine of [false, true]) {
  for (const width of [390, 320]) {
    for (const [what, text] of [['a one-word message', '네'], ['a long message', LONG]] as const) {
      test(`[SID:4887] touch ${width} · ${mine ? 'my' : 'their'} ${what}: the touch reply button sits beside «⋯» — 44 × 44, no overlap, on the screen, list does not scroll sideways`, async ({ browser }) => {
        const s = await scene(browser, { touch: true, mine, width, withReply: true, withMenu: true, text, continuation: true });
        expect(await s.display('#reply'), 'the mouse twin is gone on touch').toBe('none');
        const r = (await s.box('#replyT'))!; const m = (await s.box('#more'))!;
        expect(r.width, `44 wide (${Math.round(r.width)})`).toBeGreaterThanOrEqual(44); expect(r.height, `44 tall (${Math.round(r.height)})`).toBeGreaterThanOrEqual(44);
        expect(overlaps(r, m), `reply ${JSON.stringify(r)} vs ⋯ ${JSON.stringify(m)}`).toBe(false); // reverted (ml-1: right on «⋯») → they overlap
        for (const [n, b] of [['reply', r], ['⋯', m]] as const) {
          expect(b.x, `${n} inside the screen (left)`).toBeGreaterThanOrEqual(0);
          expect(b.x + b.width, `${n} inside the screen (right)`).toBeLessThanOrEqual(width);
        }
        const ov = await s.listOverflow();
        expect(ov.scroll, 'the list does not scroll sideways').toBeLessThanOrEqual(ov.client);
        expect(ov.docScroll, 'no horizontal overflow on the page').toBeLessThanOrEqual(ov.docClient);
        await s.context.close();
      });

      test(`[SID:4887] touch ${width} · ${mine ? 'my' : 'their'} ${what}: two same-sender messages in a row — the second row's controls never reach into the first row's (and the reverse)`, async ({ browser }) => {
        const s = await scene(browser, { touch: true, mine, width, withReply: true, withMenu: true, text, continuation: true, rows: 2 });
        const b = async (id: string) => (await s.box(id))!;
        const first = [await b('#replyT'), await b('#more')]; const second = [await b('#replyT2'), await b('#more2')];
        for (const x of first) for (const y of second) expect(overlaps(x, y), `row 1 ${JSON.stringify(x)} vs row 2 ${JSON.stringify(y)}`).toBe(false); // reverted (a lifted button at the column top) → the second row's reply covers the first row's «⋯»
        await s.context.close();
      });
    }

    test(`[SID:4887] touch ${width} · ${mine ? 'my' : 'their'} full-width long bubble: the bubble is exactly as wide with the buttons as without them; the touch button stays on the screen and only its bottom edge touches the bubble`, async ({ browser }) => {
      const after = await scene(browser, { touch: true, mine, width, withReply: true, withMenu: true, text: LONG, continuation: true });
      const widthAfter = (await after.box('#text'))!.width; const textBox = (await after.box('#text'))!; const r = (await after.box('#replyT'))!;
      const ov = await after.listOverflow();
      const intrusion = Math.max(0, Math.min(textBox.y + textBox.height, r.y + r.height) - Math.max(textBox.y, r.y)); // how far the 44 px hit area reaches up into the bubble's bottom edge
      expect(r.x + r.width, 'inside the screen').toBeLessThanOrEqual(width); expect(r.x, 'inside the screen').toBeGreaterThanOrEqual(0);
      expect(ov.scroll, 'the list does not scroll sideways').toBeLessThanOrEqual(ov.client);
      expect(intrusion, `the hit area reaches ${Math.round(intrusion)} px into the bubble's bottom edge (the same band «⋯» already uses)`).toBeLessThanOrEqual(22);
      await after.context.close();
      const before = await scene(browser, { touch: true, mine, width, withReply: false, withMenu: true, text: LONG, continuation: true });
      const widthBefore = (await before.box('#text'))!.width;
      await before.context.close();
      expect(widthAfter, `max bubble width before ${Math.round(widthBefore)} → after ${Math.round(widthAfter)}`).toBeCloseTo(widthBefore, 0);
      if (process.env.P6A_NUMBERS) appendFileSync(process.env.P6A_NUMBERS, JSON.stringify({ width, mine, bubbleBefore: Math.round(widthBefore), bubbleAfter: Math.round(widthAfter), replyRight: Math.round(r.x + r.width), replyLeft: Math.round(r.x), intrusionIntoBubble: Math.round(intrusion), listScroll: ov.scroll, listClient: ov.client }) + '\n');
    });
  }
}

for (const mine of [false, true]) {
  const who = mine ? 'my' : 'their';

  test(`[SID:4887] mouse · ${who} message: the reply button is hidden until the row is hovered, then sits beside the bubble on the outer side — and nothing moves`, async ({ browser }) => {
    const { page, context, box, opacity } = await scene(browser, { touch: false, mine, width: 700, withReply: true });
    expect(await opacity('#reply'), 'hidden at rest').toBe(0);
    const belowBefore = (await box('#below'))!.y; const colBefore = (await box('#col'))!;
    await page.hover('#row');
    expect(await opacity('#reply'), 'shown while the row is hovered').toBe(1); // reverted (no hover reveal) → stays 0
    const r = (await box('#reply'))!; const col = (await box('#col'))!;
    if (mine) { expect(r.x + r.width, 'left of my bubble').toBeLessThanOrEqual(col.x + 1); expect(col.x - (r.x + r.width), 'within 12 px of it').toBeLessThanOrEqual(12); }
    else { expect(r.x, 'right of their bubble').toBeGreaterThanOrEqual(col.x + col.width - 1); expect(r.x - (col.x + col.width), 'within 12 px of it').toBeLessThanOrEqual(12); }
    expect(r.width, 'a compact icon button for a mouse').toBeLessThanOrEqual(32);
    expect((await box('#below'))!.y, 'nothing moved').toBeCloseTo(belowBefore, 0);
    expect((await box('#col'))!.width).toBeCloseTo(colBefore.width, 0);
    await context.close();
  });

  test(`[SID:4887] mouse · ${who} message: keyboard focus on the button shows it (WCAG 1.4.13) — it is hidden by opacity, so a keyboard can reach it`, async ({ browser }) => {
    const { page, context, opacity } = await scene(browser, { touch: false, mine, width: 700, withReply: true });
    expect(await opacity('#reply')).toBe(0);
    await page.focus('#reply');
    expect(await opacity('#reply'), 'shown while it holds focus').toBe(1); // reverted (hover only) → stays 0
    await context.close();
  });

  test(`[SID:4887] mouse · ${who} CONTINUATION: the hover time and the reply button sit side by side on the outer side and never overlap`, async ({ browser }) => {
    const { page, context, box } = await scene(browser, { touch: false, mine, width: 700, withReply: true, continuation: true });
    await page.hover('#row');
    const r = (await box('#reply'))!; const m = (await box('#meta'))!;
    // the time is further out than the button: their = time.x ≥ button right; mine = time right ≤ button left
    if (mine) expect(m.x + m.width, 'my time is left of my reply button').toBeLessThanOrEqual(r.x + 1);
    else expect(m.x, 'their time is right of their reply button').toBeGreaterThanOrEqual(r.x + r.width - 1); // reverted (ml-2) → under the button
    await context.close();
  });
}

for (const mine of [false, true]) {
  const who = mine ? 'my' : 'their';

  for (const width of [320, 360, 400, 480, 700]) {
    test(`[SID:4887] mouse ${width} · ${who} full-width CONTINUATION: the hover time (moved out for the reply button) lies inside the screen at EVERY window width — the column gives way, and the list does not scroll sideways`, async ({ browser }) => {
      const s = await scene(browser, { touch: false, mine, width, withReply: true, text: LONG, continuation: true });
      await s.page.hover('#row');
      const m = (await s.box('#meta'))!;
      expect(m.x, `the time starts inside the screen (${Math.round(m.x)})`).toBeGreaterThanOrEqual(0); // reverted to a wider offset → past the right edge on the narrow windows
      expect(m.x + m.width, `the time ends inside the screen (${Math.round(m.x + m.width)} of ${width})`).toBeLessThanOrEqual(width);
      const ov = await s.listOverflow();
      expect(ov.scroll, 'the list does not scroll sideways').toBeLessThanOrEqual(ov.client);
      await s.context.close();
    });
  }

  test(`[SID:4887] ${who} message: exactly ONE reply twin is shown per device — the mouse twin on a mouse (the touch twin is display:none), the touch twin on a touch screen (the mouse twin is display:none)`, async ({ browser }) => {
    const mouse = await scene(browser, { touch: false, mine, width: 700, withReply: true, withMenu: true, continuation: true });
    expect(await mouse.display('#replyT'), 'a mouse never meets the touch twin').toBe('none'); // reverted (touch twin without `hidden`) → inline-flex
    expect(await mouse.display('#reply'), 'a mouse meets the mouse twin').not.toBe('none');
    await mouse.context.close();
    const touch = await scene(browser, { touch: true, mine, width: 390, withReply: true, withMenu: true, continuation: true });
    expect(await touch.display('#reply'), 'a touch screen never meets the mouse twin').toBe('none'); // reverted (mouse twin not hidden on touch) → inline-flex
    expect(await touch.display('#replyT'), 'a touch screen meets the touch twin').not.toBe('none');
    await touch.context.close();
  });
}

for (const mine of [false, true]) {
  const who = mine ? 'my' : 'their';
  for (const width of [500, 700]) {
    test(`[SID:4887] mouse ${width} · ${who} full-width bubble: a wide window keeps the usual 72% (the width cap changes nothing there)`, async ({ browser }) => {
      const s = await scene(browser, { touch: false, mine, width, withReply: true, text: LONG, continuation: true });
      const row = (await s.box('#row'))!; const col = (await s.box('#col'))!;
      expect(col.width, `column ${Math.round(col.width)} of row ${Math.round(row.width)}`).toBeCloseTo(row.width * 0.72, 0); // reverted/over-tight cap (e.g. 100% − 200px) → narrower than 72%
      await s.context.close();
    });
  }
  for (const width of [320, 360]) {
    test(`[SID:4887] mouse ${width} · ${who} full-width bubble: a narrow window gives the bubble less than 72% so the reply button and the hover time beside it fit`, async ({ browser }) => {
      const s = await scene(browser, { touch: false, mine, width, withReply: true, text: LONG, continuation: true });
      const row = (await s.box('#row'))!; const col = (await s.box('#col'))!;
      expect(col.width, `column ${Math.round(col.width)} ≤ row ${Math.round(row.width)} − 128`).toBeLessThanOrEqual(row.width - 128 + 1); // reverted (no cap) → 72%
      expect(col.width, 'and the bubble is still wide enough to read').toBeGreaterThan(100);
      await s.context.close();
    });
  }
}

for (const mine of [false, true]) {
  const who = mine ? 'my' : 'their';
  test(`[SID:4887] mouse 320 · ${who} full-width bubble WITHOUT a reply button (inside a thread): the bubble keeps its usual 72% and the hover time keeps its 8 px offset — the PR changes nothing there`, async ({ browser }) => {
    const s = await scene(browser, { touch: false, mine, width: 320, withReply: false, text: LONG, continuation: true });
    await s.page.hover('#row');
    const row = (await s.box('#row'))!; const col = (await s.box('#col'))!; const m = (await s.box('#meta'))!;
    expect(col.width, `column ${Math.round(col.width)} of row ${Math.round(row.width)}`).toBeCloseTo(row.width * 0.72, 0); // reverted (the cap everywhere) → narrower
    const gap = mine ? col.x - (m.x + m.width) : m.x - (col.x + col.width);
    expect(gap, `the hover time sits ${Math.round(gap)} px from the bubble`).toBeCloseTo(8, 0); // reverted (always 36) → 36
    await s.context.close();
  });
}
