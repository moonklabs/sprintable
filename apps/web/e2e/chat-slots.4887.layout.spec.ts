/**
 * story 4887 (UI-4 P6-b · AC3 «슬롯 폭») — the two side slots of the chat page, measured in Chromium with the class strings READ FROM the source (chats/layout.tsx · chat-view.tsx) and the real Tailwind build of globals.css,
 * and the real `ThreadPanel` mounted at the slot's width. The rule: between lg (1024) and xl (1280) the list slot is 248 px (270 before) and the thread slot a FIXED 300 px (it was an even split with the room), so the room body gets 480 px of a 1028 px window instead of 379 —
 * 232 px is the narrowest list width at which the real `ChatListView` reads as it does at 270 on a Mac (ten rows: 224 px newly cuts the short computer name «SYJ-Mac» that P2-e made readable, two more titles and a project name), but the CI's Linux font is wider and cuts it at 232 — 248 keeps a margin on both;
 * from xl up nothing changes (270 and 320). The thread panel must not overflow at 300.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { compile, optimize } from '@tailwindcss/node';
import { layoutStubPlugin } from './support/layout-stubs';

const req = createRequire(__filename);
const WEB = path.join(__dirname, '..');
const APP = path.join(WEB, 'src', 'app');
const read = (rel: string) => readFileSync(path.join(WEB, 'src', rel), 'utf8');

/** the class strings of the three panes, as the source writes them — what is RENDERED while a thread is open (the thread wrapper exists only then) */
function slotClasses() {
  const layout = read('app/(authenticated)/chats/layout.tsx');
  const view = read('components/chat/chat-view.tsx');
  const rail = /className=\{`\$\{isListRoute \? 'flex' : 'hidden'\} (lg:flex min-h-0 w-full flex-col[^`$]*?)\$\{railHiddenClass\}/.exec(layout);
  if (!rail) throw new Error('the list slot classes not found');
  const thread = /<div className="(motion-safe:animate-in[^"]*)">\s*<ThreadPanel/.exec(view);
  if (!thread) throw new Error('the thread slot classes not found');
  const main = /className=\{`(flex min-w-0 flex-1 flex-col overflow-hidden) \$\{isMobileRightPanelView \? '(hidden lg:flex)' : 'flex'\}`\}/.exec(view);
  if (!main) throw new Error('the main column classes not found');
  const overlay = /const railOverlayClass = railMode === 'overlay'\s*\? '([^']+)'/.exec(layout);
  if (!overlay) throw new Error('the overlay rail classes not found');
  return { overlay: overlay[1]!.trim(), rail: rail[1]!.trim(), thread: thread[1]!.trim(), mainOpen: `${main[1]} ${main[2]}`, mainClosed: `${main[1]} flex` };
}

async function css(classes: string[]): Promise<string> {
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  return (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(classes), { minify: false }).code;
}

/** the three panes side by side at a window width: the app shell takes 72 px (the 56 px nav rail + two 8 px insets), so a 1100 window leaves a 1028 body */
const SHELL = 72;
async function shell(page: Page, viewport: number, withThread: boolean) {
  const c = slotClasses();
  const all = [c.rail, c.overlay, c.thread, c.mainOpen, c.mainClosed, 'flex', 'flex min-h-0 flex-1 overflow-hidden'].join(' ').split(/\s+/).filter(Boolean);
  await page.setViewportSize({ width: viewport, height: 700 });
  await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${await css(all)}</style></head><body style="margin:0">
    <div id="body" class="flex min-h-0 flex-1 overflow-hidden" style="width:${viewport - SHELL}px;height:600px;margin-left:${SHELL}px">
      <div id="rail" class="flex ${c.rail}"></div>
      <div id="main" class="${withThread ? c.mainOpen : c.mainClosed}"></div>
      ${withThread ? `<div id="thread" class="${c.thread}"></div>` : ''}
    </div></body></html>`);
  const w = (id: string) => page.locator(id).evaluate((e) => Math.round(e.getBoundingClientRect().width));
  return { rail: await w('#rail'), main: await w('#main'), thread: withThread ? await w('#thread') : null, body: viewport - SHELL };
}

test('[SID:4887] a 1100 px window (lg): the list slot is 248, the thread slot 300, and the room body gets 480 of the 1028 px — it was 379', async ({ page }) => {
  const g = await shell(page, 1100, true);
  expect(g.rail, 'list slot').toBe(248); // reverted (270) → 270
  expect(g.thread, 'thread slot').toBe(300); // reverted (w-80) → 320
  expect(g.main, `room body of ${g.body} px`).toBe(480); // reverted → 438 (and with the thread flex-1 → 391)
});

test('[SID:4887] the list brought back as an overlay drawer at lg stays 270 px (the narrower slot is the in-flow list only)', async ({ page }) => {
  const c = slotClasses();
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.setContent(`<!doctype html><html><head><style>${await css([c.rail, c.overlay, 'flex'].join(' ').split(/\s+/).filter(Boolean))}</style></head><body style="margin:0"><div id="rail" class="flex ${c.rail} ${c.overlay}"></div></body></html>`);
  const w = await page.locator('#rail').evaluate((e) => Math.round(e.getBoundingClientRect().width));
  expect(w, 'overlay drawer').toBe(270); // reverted (no lg override) → 232
});

test('[SID:4887] a thread open is NOT an even split with the room: the thread slot is FIXED (the old second branch was dead code, so it was flex-1 beside a flex-1 room)', async ({ page }) => {
  const g = await shell(page, 1100, true);
  expect(g.thread, `thread ${g.thread} px vs room ${g.main} px of ${g.body - g.rail}`).not.toBe(Math.round((g.body - g.rail) / 2)); // the old behaviour: 398 / 398
  expect(g.thread).toBe(300);
});

test('[SID:4887] a 1100 px window (lg) with no thread open: the list slot is 248 and the room body gets the rest', async ({ page }) => {
  const g = await shell(page, 1100, false);
  expect(g.rail).toBe(248);
  expect(g.main).toBe(1028 - 248);
});

test('[SID:4887] a 1440 px window (xl): nothing changes — the list slot stays 270 and the thread slot 320', async ({ page }) => {
  const g = await shell(page, 1440, true);
  expect(g.rail, 'list slot').toBe(270); // the xl width is NOT narrowed
  expect(g.thread, 'thread slot').toBe(320);
  expect(g.main).toBe(1440 - 72 - 270 - 320);
});

test('[SID:4887] 1024 px (the narrowest lg window): the room body still gets at least 400 with a thread open', async ({ page }) => {
  const g = await shell(page, 1024, true);
  expect(g.main, `room body ${g.main} px (952 − 248 − 300)`).toBeGreaterThanOrEqual(400);
});

// ── the real ThreadPanel at the slot's width ────────────────────────────────────────────────────────────────────────────────────────────────────
const LONG_WORD = 'https://example.com/a-very-long-unbreakable-url-without-any-space-in-it-that-keeps-going/and/going/and/going?x=1&y=2&z=3';
const REPLIES = [
  { id: 'r1', conversation_id: 'c1', parent_id: 'p1', created_by: 'a-1', sender_name: 'Lead · AC4 isolated daemon', sender_type: 'agent', sender_runtime_type: 'claude-code', content: `긴 답글입니다 — ${'폭이 좁은 스레드 칸에서도 넘치지 않는지 보려고 길게 씁니다. '.repeat(4)}`, created_at: '2026-11-10T03:00:00Z', attachments: [] },
  { id: 'r2', conversation_id: 'c1', parent_id: 'p1', created_by: 'me-1', sender_name: '나', sender_type: 'human', content: `내 답글 ${LONG_WORD}`, created_at: '2026-11-10T03:01:00Z', attachments: [] },
  { id: 'r3', conversation_id: 'c1', parent_id: 'p1', created_by: 'h-1', sender_name: '요한 슈뢰딩거 (Johann Schrödinger)', sender_type: 'human', content: '```\nconst veryLongIdentifierName = someFunctionWithALongName(argumentNumberOne, argumentNumberTwo, argumentNumberThree);\n```', created_at: '2026-11-10T03:02:00Z', attachments: [] },
];
const PARENT = { id: 'p1', conversation_id: 'c1', created_by: 'h-1', sender_name: '요한 슈뢰딩거 (Johann Schrödinger)', sender_type: 'human', content: `스레드를 여는 원 글입니다. ${LONG_WORD}`, created_at: '2026-11-10T02:59:00Z', attachments: [], reply_count: 3 };

let built: { js: string; css: string } | null = null;
async function build() {
  if (built) return built;
  const esbuild = req('esbuild') as typeof import('esbuild');
  const out = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react'; import { createRoot } from 'react-dom/client'; import { NextIntlClientProvider } from 'next-intl';
        import ko from './messages/ko.json';
        import { ThreadPanel } from './src/components/chat/thread-panel';
        window.__mount = (w) => {
          createRoot(document.getElementById('root')).render(React.createElement(NextIntlClientProvider, { locale: 'ko', messages: ko, timeZone: 'Asia/Seoul' },
            React.createElement('div', { id: 'slot', className: 'flex flex-col overflow-hidden', style: { width: w + 'px', height: '640px' } },
              React.createElement(ThreadPanel, { parentMessage: ${JSON.stringify(PARENT)}, conversationId: 'c1', currentTeamMemberId: 'me-1', projectId: 'p1', onClose() {} }))));
        };`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_APP_URL': '"https://app.sprintable.ai"' },
    plugins: [layoutStubPlugin()],
  });
  const js = out.outputFiles[0]!.text;
  const candidates = [...new Set([...js.matchAll(/"([^"\n]+)"/g)].flatMap((m) => m[1]!.split(/\s+/)).filter(Boolean)), 'flex flex-col overflow-hidden'];
  built = { js, css: await css(candidates) };
  return built;
}

async function openThread(page: Page, width: number) {
  const { js, css: styles } = await build();
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.unrouteAll();
  await page.route('http://preview.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${styles}</style></head><body class="bg-background text-foreground" style="margin:0"><div id="root"></div></body></html>` });
    }
    if (url.pathname === '/api/conversations/c1/messages') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: REPLIES }) });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [] }) });
  });
  await page.goto('about:blank');
  await page.goto('http://preview.test/');
  await page.addScriptTag({ content: js });
  await page.evaluate((w) => (window as unknown as { __mount: (w: number) => void }).__mount(w), width);
  await page.locator('#slot textarea').first().waitFor();
  await page.waitForTimeout(400);
}

for (const width of [300, 320]) {
  test(`[SID:4887] the real thread panel at ${width} px: nothing runs past the slot, every button is inside it, and the reply box keeps at least 96 px`, async ({ page }) => {
    await openThread(page, width);
    const m = await page.evaluate(() => {
      const slot = document.getElementById('slot')!; const sr = slot.getBoundingClientRect();
      const outside: string[] = [];
      for (const el of slot.querySelectorAll('button, textarea, input, select, [data-testid]')) {
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.left < sr.left - 0.5 || r.right > sr.right + 0.5) outside.push(`${el.tagName.toLowerCase()}${(el as HTMLElement).dataset.testid ? '[' + (el as HTMLElement).dataset.testid + ']' : ''} ${Math.round(r.left - sr.left)}..${Math.round(r.right - sr.left)}`);
      }
      const ta = slot.querySelector('textarea') as HTMLElement;
      // a code block / table scrolls INSIDE its own box by design — what must hold is that the BOX itself stays inside the slot
      const scrollers = [...slot.querySelectorAll('*')].filter((e) => /auto|scroll/.test(getComputedStyle(e).overflowX)).map((e) => { const r = (e as HTMLElement).getBoundingClientRect(); return { over: r.right > sr.right + 0.5 || r.left < sr.left - 0.5, cls: (e as HTMLElement).className.toString().slice(0, 50) }; });
      return { slotScroll: slot.scrollWidth, slotClient: slot.clientWidth, outside, textareaW: Math.round(ta.getBoundingClientRect().width), scrollers };
    });
    expect(m.slotScroll, 'the slot does not scroll sideways').toBeLessThanOrEqual(m.slotClient);
    expect(m.outside, `controls outside the slot: ${m.outside.join(' | ')}`).toEqual([]);
    expect(m.textareaW, `reply box ${m.textareaW} px`).toBeGreaterThanOrEqual(96);
    expect(m.scrollers.filter((s) => s.over), `a scrolling block whose own box leaves the slot: ${JSON.stringify(m.scrollers)}`).toEqual([]);
    if (process.env.P6B_NUMBERS) appendFileSync(process.env.P6B_NUMBERS, JSON.stringify({ width, textareaW: m.textareaW, slotScroll: m.slotScroll, slotClient: m.slotClient }) + '\n');
  });
}

// ── the composer's popovers inside the narrower thread slot ──────────────────────────────────────────────────────────────────────────────────
for (const width of [300, 320]) {
  test(`[SID:4887] the real thread panel at ${width} px: the command list and the storage picker open INSIDE the slot (the panel clips what leaves it)`, async ({ page }) => {
    await openThread(page, width);
    const slot = page.locator('#slot');
    const inside = async (sel: string, what: string) => {
      const r = await page.evaluate((s) => { const e = document.querySelector(s) as HTMLElement | null; const sl = document.getElementById('slot')!.getBoundingClientRect(); if (!e) return null; const b = e.getBoundingClientRect(); return { left: Math.round(b.left - sl.left), right: Math.round(b.right - sl.left), w: Math.round(b.width), slot: Math.round(sl.width) }; }, sel);
      expect(r, `${what} is drawn`).not.toBeNull();
      expect(r!.left, `${what} starts inside the slot (${JSON.stringify(r)})`).toBeGreaterThanOrEqual(0);
      expect(r!.right, `${what} ends inside the slot (${JSON.stringify(r)})`).toBeLessThanOrEqual(r!.slot); // reverted (fixed w-80 / w-[372px]) → past the slot and clipped
      return r!;
    };
    await slot.locator('textarea').first().fill('/');
    await page.locator('#slot [role="listbox"]').first().waitFor();
    await inside('#slot [role="listbox"]', 'the command list');
    await slot.locator('textarea').first().fill('');
    await page.locator('#slot [data-testid="chat-attach-more"]').click();
    await page.getByRole('menuitem').first().click();
    await page.locator('#slot [role="dialog"]').first().waitFor();
    await inside('#slot [role="dialog"]', 'the storage picker');
  });
}
