/**
 * story 4887 (UI-4 P4-a) — where a message's time is drawn, measured in Chromium with the component's OWN class strings (read from chat-bubble.tsx) and the real Tailwind build of globals.css.
 * The rule: a run of one sender shows its time ONCE, in the head line beside the name; the other messages of the run show theirs beside the bubble only while the row is hovered — without moving anything.
 * That holds where a mouse can hover (fine pointer + hover). On a touch screen the line under each bubble stays (the touch «⋯» button sits on it — story 4855; there is no hover to reveal a time).
 * The stacked variant `[@media(pointer:fine)_and_(hover:hover)]:group-hover/bubble:…` is the thing most likely to be wrong, so it is the thing measured: if Tailwind did not generate it, the hover time never shows.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Browser } from '@playwright/test';
import { compile, optimize } from '@tailwindcss/node';

const BUBBLE = path.join(__dirname, '../src/components/chat/chat-bubble.tsx');
const APP = path.join(__dirname, '../src/app');

function classesFromSource() {
  const src = readFileSync(BUBBLE, 'utf8');
  const pick = (re: RegExp, what: string, i = 1) => { const m = re.exec(src); if (!m) throw new Error(`${what} not found`); return m[i]!; };
  const cont = /\? \(isMine\s*\? '([^']+)'\s*: '([^']+)'\)/.exec(src);
  if (!cont) throw new Error('the continuation time line classes not found');
  return {
    row: pick(/className=\{`(group\/bubble flex scroll-mt-4 gap-2 transition-shadow )\$\{isMine/, 'the row'),
    column: pick(/<div (?:data-chat-content="" )?className=\{`((?:relative )?flex min-w-0 max-w-\[72%\] (?:\S+ )*?flex-col gap-0\.5 )\$\{isMine/, 'the message column'),
    text: pick(/<div data-testid="chat-bubble-text" className=\{`([^$`]+)\$\{/, 'the bubble text box').trim(),
    // story 4887 (UI-4 P4-b): the fill · rounding · padding are per-sender variants now — measure a person's bubble (mine / another's), the geometry the time rules were written against
    textMine: pick(/isMine\s*\?\s*'([^']+)'\s*:\s*isAgent\s*\?\s*'([^']+)'\s*:\s*'([^']+)'\s*\}`\}\s*data-bubble=/, 'the bubble variant (mine)'),
    textPerson: ((m) => { if (!m) throw new Error('the bubble variant (person) not found'); return m[3]!; })(/isMine\s*\?\s*'([^']+)'\s*:\s*isAgent\s*\?\s*'([^']+)'\s*:\s*'([^']+)'\s*\}`\}\s*data-bubble=/.exec(src)),
    headTime: pick(/<time className="([^"]+)" dateTime=\{message\.created_at\} data-testid="bubble-head-time">/, 'the head time'),
    metaTime: pick(/<time className="([^"]+)" dateTime=\{message\.created_at\}><ViewerDate/, 'the meta time'),
    contMine: cont[1]!,
    contTheirs: cont[2]!,
    first: pick(/: '(relative inline-block \[@media\(pointer:fine\)_and_\(hover:hover\)\]:hidden)'\}/, 'the first-of-run time line'),
  };
}

async function css(classes: string[]): Promise<string> {
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  return (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(classes), { minify: false }).code;
}

type Box = { x: number; y: number; width: number; height: number };

/** one row: the avatar gutter · the column (head line when the message starts a run) · the bubble text · the meta line; `below` is the next message */
async function scene(browser: Browser, o: { touch: boolean; mine: boolean; startsRun: boolean }) {
  const c = classesFromSource();
  const side = o.mine ? 'items-end' : 'items-start';
  const meta = o.startsRun ? c.first : (o.mine ? c.contMine : c.contTheirs);
  const textCls = `${c.text} ${o.mine ? c.textMine : c.textPerson}`;
  const all = [c.row, c.column, textCls, c.headTime, c.metaTime, meta, 'flex-row-reverse flex-row', 'items-end items-start', 'flex items-center gap-1.5 text-micro', 'h-7 w-7 flex-shrink-0 rounded-full bg-info/15']
    .join(' ').split(/\s+/).filter(Boolean);
  const context = await browser.newContext(o.touch ? { viewport: { width: 700, height: 600 }, hasTouch: true, isMobile: true } : { viewport: { width: 700, height: 600 } });
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${await css(all)}</style></head><body style="margin:0">
    <div style="padding:8px 120px">
      <div id="row" class="${c.row}${o.mine ? 'flex-row-reverse' : 'flex-row'}">
        ${o.startsRun ? '<div id="avatar" class="h-7 w-7 flex-shrink-0 rounded-full bg-info/15"></div>' : '<div class="w-7 flex-shrink-0"></div>'}
        <div id="col" class="${c.column}${side}">
          ${o.startsRun ? `<div id="headline" class="flex items-center gap-1.5"><span>이름</span><time id="head-time" class="${c.headTime}">오전 07:32</time></div>` : ''}
          <div id="text" class="${textCls}">짧은 글 <a id="link" href="#x">링크</a></div>
          <span id="meta" class="${meta}"><time id="time" class="${c.metaTime}">오전 07:33</time></span>
        </div>
      </div>
      <div id="below" style="height:20px">next message</div>
    </div></body></html>`);
  const box = async (sel: string) => (await page.locator(sel).boundingBox()) as Box | null;
  // «shown» = the element is drawn and big enough to be seen. The meta CELL is what is hidden or revealed (a screen-reader-only cell clips its child to 1 px: the child's own box is not what the eye sees)
  const shown = (sel: string) => page.locator(sel).evaluate((e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 4 && r.height > 4; });
  const display = (sel: string) => page.locator(sel).evaluate((e) => getComputedStyle(e).display);
  return { page, context, box, shown, display };
}

for (const mine of [false, true]) {
  const who = mine ? 'my' : 'their';

  test(`[SID:4887] mouse · ${who} CONTINUATION: no time line takes room; hovering the row shows the time beside the bubble and moves nothing`, async ({ browser }) => {
    const { page, context, box, shown } = await scene(browser, { touch: false, mine, startsRun: false });
    const col = (await box('#col'))!;
    const text = (await box('#text'))!;
    expect(col.height, 'the column holds the bubble only — the time line takes no row').toBeLessThanOrEqual(text.height + 2);
    expect(await shown('#meta'), 'the time cell is not drawn until the row is hovered (it stays in the tree for screen readers)').toBe(false);
    expect(await page.locator('#time').textContent()).toBe('오전 07:33');
    const belowBefore = (await box('#below'))!.y;
    await page.hover('#row');
    expect(await shown('#meta'), 'drawn while the row is hovered').toBe(true); // reverted (the stacked variant not generated) → stays clipped
    const meta = (await box('#meta'))!;
    // beside the bubble — on the outer side AND close to it (without the column as the positioned parent the time flies to the edge of the screen: «right of the bubble» alone would still pass)
    if (mine) { expect(meta.x + meta.width, 'my time is left of the bubble').toBeLessThanOrEqual(col.x + 1); expect(col.x - (meta.x + meta.width), 'and within 48 px of it (P6-a: the reply button takes the first 36)').toBeLessThanOrEqual(48); }
    else { expect(meta.x, 'their time is right of the bubble').toBeGreaterThanOrEqual(col.x + col.width - 1); expect(meta.x - (col.x + col.width), 'and within 48 px of it (P6-a: the reply button takes the first 36)').toBeLessThanOrEqual(48); }
    expect((await box('#below'))!.y, 'nothing moved').toBeCloseTo(belowBefore, 0);
    expect((await box('#col'))!.height).toBeCloseTo(col.height, 0);
    await context.close();
  });

  test(`[SID:4887] mouse · ${who} CONTINUATION: keyboard focus inside the bubble shows the time beside it too (WCAG 1.4.13 — what hover reveals, focus reveals)`, async ({ browser }) => {
    const { page, context, box, shown } = await scene(browser, { touch: false, mine, startsRun: false });
    expect(await shown('#meta'), 'not shown before anything holds focus').toBe(false);
    await page.focus('#link'); // a link inside the bubble — what a keyboard user can reach
    expect(await shown('#meta'), 'shown while the row holds focus').toBe(true); // reverted (hover only) → stays clipped
    const col = (await box('#col'))!;
    const meta = (await box('#meta'))!;
    if (mine) expect(col.x - (meta.x + meta.width), 'within 48 px, left of my bubble (P6-a: the reply button takes the first 36)').toBeLessThanOrEqual(48);
    else expect(meta.x - (col.x + col.width), 'within 48 px, right of their bubble (P6-a: the reply button takes the first 36)').toBeLessThanOrEqual(48);
    await context.close();
  });

  test(`[SID:4887] mouse · ${who} first message of a run: the time is in the head, the line under the bubble is gone`, async ({ browser }) => {
    const { page, context, box, shown, display } = await scene(browser, { touch: false, mine, startsRun: true });
    expect(await shown('#head-time'), 'the head shows the time').toBe(true);
    expect(await display('#meta'), 'no time line under the bubble').toBe('none'); // reverted (line kept) → inline-block
    const col = (await box('#col'))!;
    const text = (await box('#text'))!;
    const head = (await box('#headline'))!;
    expect(col.height, 'head line + bubble (+ the 2 px gap) only').toBeLessThanOrEqual(head.height + text.height + 4);
    await page.hover('#row');
    expect(await display('#meta'), 'hovering adds nothing — the head already says it').toBe('none');
    await context.close();
  });

  test(`[SID:4887] touch · ${who} message: the line under each bubble stays (the «⋯» button sits on it) and the head does not repeat the time`, async ({ browser }) => {
    for (const startsRun of [true, false]) {
      const { context, box, shown } = await scene(browser, { touch: true, mine, startsRun });
      expect(await shown('#meta'), 'the time line is drawn without any hover').toBe(true);
      const col = (await box('#col'))!;
      const text = (await box('#text'))!;
      expect(col.height, 'the line takes its row').toBeGreaterThan(text.height + 8);
      if (startsRun) expect(await shown('#head-time'), 'the head does not repeat it on touch').toBe(false);
      await context.close();
    }
  });
}
