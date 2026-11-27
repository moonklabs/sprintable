/**
 * story 5031 (pencil follow-up) — the desktop head's rename pencil is QUIET until the hand is on the head's first line or the focus is inside it (where a mouse can hover: the repo's `mouse:` variant); a finger (coarse pointer) always sees it; while the name is being edited the input is always drawn.
 * The REAL RoomHead (its first line carries `group/head`) + the real ds IconButton + the real Tailwind build in Chromium. The pencil's wrapper classes are READ FROM the page's source (page.tsx), not retyped here — a change there is what is measured.
 * Quiet = `opacity: 0`, never `display: none` / `visibility: hidden`: a Tab still reaches the pencil (and shows it).
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
const PAGE_SRC = readFileSync(path.join(APP, '(authenticated)', 'chats', '[conversation_id]', 'page.tsx'), 'utf8');
const m = /<span className="(flex [^"]*)" data-testid="room-head-pencil">/.exec(PAGE_SRC);
if (!m) throw new Error('page.tsx: the pencil wrapper (data-testid="room-head-pencil") was not found');
const PENCIL_CLASS = m[1]!;

let built: { js: string; css: string } | null = null;
async function build() {
  if (built) return built;
  const esbuild = req('esbuild') as typeof import('esbuild');
  const out = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react'; import { createRoot } from 'react-dom/client';
        import { RoomHead } from './src/components/chat/room-head';
        import { IconButton } from './src/components/ds/icon-button';
        const CHIPS = [{ id: 'm1', who: '지우(나)' }, { id: 'm2', who: '개발 에이전트' }];
        window.__editing = false;
        window.__mount = (pencilClass) => {
          const rename = window.__editing
            ? React.createElement('input', { 'aria-label': '방 이름 바꾸기', defaultValue: '점심 모임', 'data-testid': 'rename-input' })
            : React.createElement('span', { className: pencilClass, 'data-testid': 'room-head-pencil' }, React.createElement(IconButton, { icon: 'edit', label: '방 이름 바꾸기', onClick: () => {} }));
          createRoot(document.getElementById('root')).render(React.createElement('div', { id: 'frame', className: 'bg-ds-background', style: { width: 900 } },
            React.createElement(RoomHead, { rename, tag: '프로젝트 방', subline: 'Launch week · 2명', chips: CHIPS, moreCount: 0, addLabel: '참여자 추가', onAdd: () => {}, trailing: React.createElement('button', { type: 'button', 'aria-label': '방 더보기' }, '⋯') })));
        };`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_APP_URL': '"https://app.sprintable.ai"' },
    plugins: [layoutStubPlugin()],
  });
  const js = out.outputFiles[0]!.text;
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  // the pencil wrapper's classes live in page.tsx (not in the bundle): hand them to the real Tailwind scan
  const css = (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build([...tailwindCandidates(js), ...PENCIL_CLASS.split(/\s+/)]), { minify: false }).code;
  built = { js, css };
  return built;
}
test.beforeAll(async () => { test.setTimeout(180_000); await build(); });

async function open(page: Page, win: number, editing = false) {
  const { js, css } = await build();
  await page.setViewportSize({ width: win, height: 900 });
  await page.unrouteAll();
  await page.route('http://preview.test/**', async (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body style="margin:0"><div id="root"></div></body></html>` }));
  await page.goto('about:blank'); await page.goto('http://preview.test/');
  await page.addScriptTag({ content: js });
  await page.evaluate(([e, cls]) => { const w = window as unknown as { __editing: boolean; __mount: (c: string) => void }; w.__editing = e as boolean; w.__mount(cls as string); }, [editing, PENCIL_CLASS]);
  await page.getByTestId('room-head').waitFor({ state: 'attached' });
}
const pencilOpacity = (page: Page) => page.evaluate(() => Number(getComputedStyle(document.querySelector('[data-testid="room-head-pencil"]')!).opacity));
const settled = (page: Page, want: number) => expect.poll(() => pencilOpacity(page), { message: `the pencil's opacity settles at ${want}`, timeout: 3000 }).toBe(want);

test('[SID:5031 · pencil] the wrapper\'s classes are the ones asked for (read from page.tsx): quiet by default for a mouse, shown by hover on the head / focus inside it; never hidden from a finger', () => {
  for (const c of ['mouse:opacity-0', 'mouse:group-hover/head:opacity-100', 'mouse:group-focus-within/head:opacity-100']) expect(PENCIL_CLASS.split(/\s+/), c).toContain(c);
  expect(PENCIL_CLASS.split(/\s+/), 'hiding is for a real mouse only (`mouse:`) — a bare opacity-0 would hide it from a finger').not.toContain('opacity-0');
  expect(PENCIL_CLASS).not.toMatch(/(^|\s)(hidden|invisible)(\s|$)/); // quiet is opacity, never display:none / visibility:hidden
  // while the name is being edited the input is NOT inside the quiet wrapper: the editing branch returns the bare input
  expect(/editingTitle \? renameInput : \(/.test(PAGE_SRC), 'the editing branch is the bare input').toBe(true);
});

test.describe('1440 · a mouse', () => {
  test('[SID:5031 · pencil] ⭐① by default (no hover · no focus) the pencil is transparent — yet it is in the Tab order and not hidden', async ({ page }) => {
    await open(page, 1440);
    await settled(page, 0);
    const s = await page.evaluate(() => { const b = document.querySelector('[data-testid="room-head-pencil"] button') as HTMLElement; const cs = getComputedStyle(b); const w = getComputedStyle(b.closest('[data-testid="room-head-pencil"]')!); return { tabIndex: b.tabIndex, display: cs.display, visibility: cs.visibility, wrapperDisplay: w.display, wrapperVisibility: w.visibility, w: b.getBoundingClientRect().width }; });
    expect(s.tabIndex).toBeGreaterThanOrEqual(0);
    expect(s).toMatchObject({ visibility: 'visible', wrapperVisibility: 'visible' });
    expect(s.display).not.toBe('none'); expect(s.wrapperDisplay).not.toBe('none');
    expect(s.w, 'it keeps its room (the head does not jump when it shows)').toBeGreaterThan(20);
  });

  test('[SID:5031 · pencil] ⭐② the hand on the head\'s first line shows it (the tag · the facts line) — and off the head it is quiet again', async ({ page }) => {
    await open(page, 1440);
    await page.getByTestId('room-head-subline').hover();
    await settled(page, 1);
    await page.mouse.move(5, 600); // away from the head
    await settled(page, 0);
  });

  test('[SID:5031 · pencil] ⭐③ Tab onto the pencil shows it (focus inside the head)', async ({ page }) => {
    await open(page, 1440);
    await settled(page, 0);
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('방 이름 바꾸기');
    await settled(page, 1);
    await page.keyboard.press('Tab'); // on to the next control («+»/«⋯»): the focus is still inside the head → still shown
    await settled(page, 1);
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    await page.mouse.move(5, 600);
    await settled(page, 0);
  });

  test('[SID:5031 · pencil] ⑤ while the name is edited the input is drawn (no quiet wrapper around it)', async ({ page }) => {
    await open(page, 1440, true);
    const s = await page.evaluate(() => { const i = document.querySelector('[data-testid="rename-input"]') as HTMLElement; let o = 1; for (let e: HTMLElement | null = i; e; e = e.parentElement) o = Math.min(o, Number(getComputedStyle(e).opacity)); const r = i.getBoundingClientRect(); return { minOpacityUpTree: o, w: r.width, h: r.height }; });
    expect(s.minOpacityUpTree).toBe(1);
    expect(s.w).toBeGreaterThan(20);
    expect(await page.locator('[data-testid="room-head-pencil"]').count(), 'no pencil while editing').toBe(0);
  });
});

test.describe('a finger (coarse pointer)', () => {
  test.use({ hasTouch: true });
  test('[SID:5031 · pencil] ⭐④ the pencil is always there — no hover needed', async ({ page }) => {
    await open(page, 1440);
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), 'the scene is a coarse-pointer one').toBe(true);
    await settled(page, 1);
  });
});

test('[SID:5031 · pencil] ⑥ a phone (390): the desktop head — and its pencil — is not drawn at all (the title button of the phone bar is the jsdom tests\')', async ({ page }) => {
  await open(page, 390);
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="room-head"]')!).display)).toBe('none');
  expect(await page.evaluate(() => (document.querySelector('[data-testid="room-head-pencil"] button') as HTMLElement).getClientRects().length), 'the pencil takes no box').toBe(0);
});
