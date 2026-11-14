/**
 * story 4923 (reopened 11-14) — the board on a low Mac window, measured in Chromium with the REAL KanbanBoard (bundled here with esbuild, not copied), the REAL frame class (read from flow-client.tsx),
 * real dnd-kit and the real Tailwind build. No server and no sign-in — the page and its fetch answers are made here (14 stories).
 * What the PO found on dev (1100×420): the scroll box inside a column was 69px while a card is 78px → the first card of every column was cut 9px short («다 보이는 카드 8» counted by the window, 0 by the column box),
 * and the folded «입력 필요» strip broke its vertical label into two lines. The rule now: on a low desktop window (height ≤ 520) the board gives 24px back from the columns' OUTER padding (row 12 → 6 above and below, column 12 → 8, header gap 12 → 8),
 * the frame itself does not change (the support button's room and the «document does not scroll» rule of 4913 stay) → box 69 → 93 ≥ 90 (card 78 + 12); the strip label never wraps and the strip drops its decorative lock.
 * Also measured: drag (mouse, across columns, with the page scrolled) and the keyboard move still work.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { compile, optimize } from '@tailwindcss/node';
import { layoutStubPlugin, STUBS } from './support/layout-stubs';
import { tailwindCandidates } from './support/tailwind-candidates';

const req = createRequire(__filename);
const WEB = path.join(__dirname, '..');
const APP = path.join(WEB, 'src', 'app');

STUBS['next/navigation'] = `export const useRouter = () => ({ push() {}, replace() {}, prefetch() {}, back() {} });
  export const useSearchParams = () => new URLSearchParams('');
  export const usePathname = () => '/ws-1/proj-1/flow';
  export const useParams = () => ({});`;

const frameClassFull = (): string => {
  const src = readFileSync(path.join(WEB, 'src', 'app', '(authenticated)', '[ws]', '[proj]', 'flow', 'flow-client.tsx'), 'utf8');
  const m = src.match(/className="(h-\[calc\(100svh-var\(--shell-chrome-h\)-var\(--work-tabs-h,0px\)\)\][^"]*)" data-testid="flow-board-frame"/);
  if (!m) throw new Error('flow board frame class not found');
  return m[1]!;
};
// the three low-window padding tokens of 4923 (row · column · header): a control takes them off to reproduce the dev numbers (box 69 at 1100×420) and show that THEY are what makes the box
const LOW = 'lg:[@media(max-height:520px)]:';
const SQUEEZE_TOKENS = [`${LOW}py-1.5`, `${LOW}py-2`, `${LOW}mb-2`];

const STORY = (id: string, n: number, status: string, trust: string | undefined) => ({
  id, title: `카드 ${n}`, status, priority: 'medium', story_points: 3, epic_id: null, assignee_id: null, assignee_ids: [],
  project_id: 'proj-1', org_id: 'org-1', created_at: '2026-11-13T00:00:00Z', updated_at: '2026-11-13T00:00:00Z', trust_stage: trust, labels: [],
});
const FIXTURE: Record<string, ReturnType<typeof STORY>[]> = {
  backlog: [1, 2, 3, 4].map((n) => STORY(`b${n}`, n, 'backlog', 'queued')),
  'ready-for-dev': [5, 6, 7].map((n) => STORY(`r${n}`, n, 'ready-for-dev', 'queued')),
  'in-progress': [8, 9, 10].map((n) => STORY(`p${n}`, n, 'in-progress', 'running')),
  'in-review': [11, 12].map((n) => STORY(`v${n}`, n, 'in-review', 'claimed_done')),
  done: [13, 14].map((n) => STORY(`d${n}`, n, 'done', undefined)),
};

let built: { js: string; css: string } | null = null;
async function build() {
  if (built) return built;
  const esbuild = req('esbuild') as typeof import('esbuild');
  const own = {
    name: 'own-stubs',
    setup(b: import('esbuild').PluginBuild) {
      b.onResolve({ filter: /^@\/components\/nav\/top-bar-slot$/ }, () => ({ path: 'top-bar-slot-stub', namespace: 'own' }));
      b.onLoad({ filter: /.*/, namespace: 'own' }, () => ({ contents: 'export function TopBarSlot() { return null; }', loader: 'js' }));
    },
  };
  const out = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react'; import { createRoot } from 'react-dom/client'; import { NextIntlClientProvider } from 'next-intl';
        import ko from './messages/ko.json';
        import { KanbanBoard } from './src/components/kanban/kanban-board';
        import { ToastProvider } from './src/components/ui/toast';
        import { RealtimeProvider } from './src/components/realtime-provider';
        window.__mountBoard = () => createRoot(document.getElementById('root')).render(
          React.createElement(NextIntlClientProvider, { locale: 'ko', messages: ko, timeZone: 'Asia/Seoul' },
            React.createElement(RealtimeProvider, { currentTeamMemberId: 'me-1' },
              React.createElement(ToastProvider, null,
                React.createElement(KanbanBoard, { projectId: 'proj-1', wsSlug: 'ws-1', projSlug: 'proj-1', headLead: React.createElement('div', { 'data-testid': 'scale-ladder-slot', className: 'shrink-0', style: { width: 241, height: 34 } }, 'ladder') })))));`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'), define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [own, layoutStubPlugin()],
  });
  const js = out.outputFiles[0]!.text;
  const candidates = [...tailwindCandidates(js),
    ...frameClassFull().split(/\s+/), 'overflow-y-auto', 'flex', 'flex-col', 'px-4', 'pb-4', 'rounded-lg', 'border', 'border-border', 'px-3', 'py-2', 'text-xs', 'font-semibold', 'cursor-pointer'];
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  const css = (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(candidates), { minify: false }).code;
  built = { js, css };
  return built;
}

const PAGE = (css: string, frame: string, tabsAndStrip: boolean) => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>${css}
  :root { --shell-chrome-h: 170px; --work-tabs-h: 44px; }
  html, body { margin: 0; height: 100%; }
  body { display: flex; gap: 8px; padding: 8px; box-sizing: border-box; }
  #side { width: 312px; flex: none; }
  #scroller { width: 780px; flex: none; height: calc(100vh - 16px); overflow-y: auto; }
</style></head><body class="bg-ds-background text-ds-ink"><div id="side"></div>
<div id="scroller" class="flex flex-col">
  <div style="height:48px;flex:none"></div>${tabsAndStrip ? '<div style="height:42px;flex:none"></div>' : ''}
  <div id="tabsband" style="height:44px;flex:none"></div>
  <div class="px-4 pb-4"><div class="${frame}" data-testid="flow-board-frame"><div id="root" style="height:100%"></div></div>
    <details class="rounded-lg border border-border"><summary class="cursor-pointer px-3 py-2 text-xs font-semibold">승인 흐름에서 멈춘 것</summary><div class="p-3">…</div></details></div>
</div></body></html>`;

async function open(page: Page, o: { viewport: [number, number]; squeeze?: 'off' | 'only-row' | 'only-column' | 'only-header' }) {
  const { js, css } = await build();
  await page.setViewportSize({ width: o.viewport[0], height: o.viewport[1] });
  const frame = frameClassFull();
  await page.route('http://preview.test/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE(css, frame, true) }));
  await page.addInitScript((fx) => {
    const w = window as unknown as { __writes: Array<{ method: string; url: string; body: string }>; __dashboardCtx: unknown };
    w.__writes = [];
    const slot = document.createElement('div'); slot.id = 'banner-slot';
    document.addEventListener('DOMContentLoaded', () => document.body.appendChild(slot));
    w.__dashboardCtx = { currentTeamMemberId: 'me-1', projectMemberships: [], orgMemberships: [], currentMemberType: 'human', bottomDockBannerSlot: slot };
    (window as unknown as { EventSource: unknown }).EventSource = class { onopen = null; onmessage = null; onerror = null; addEventListener() {} close() {} };
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method !== 'GET') { w.__writes.push({ method, url, body: String(init?.body ?? '') }); return json({ data: {} }); }
      const m = url.match(/^\/api\/stories\?(.*)$/);
      if (m) { const status = new URLSearchParams(m[1]).get('status') ?? ''; const rows = (fx as Record<string, unknown[]>)[status] ?? []; return json({ data: rows, meta: { hasMore: false, nextCursor: null, totalCount: rows.length } }); }
      return json({ data: [] });
    };
  }, FIXTURE);
  await page.goto('http://preview.test/');
  const thrown: string[] = [];
  page.on('pageerror', (e) => thrown.push(e.message));
  await page.addScriptTag({ content: js });
  if (!(await page.evaluate(() => typeof (window as unknown as { __mountBoard?: unknown }).__mountBoard === 'function'))) {
    throw new Error(`the bundle did not start — likely a module to stub: ${thrown.join(' | ') || 'no page error'}`);
  }
  await page.evaluate(() => (window as unknown as { __mountBoard: () => void }).__mountBoard());
  await page.locator('[data-story-card]').first().waitFor();
  if (o.squeeze === 'off') {
    await page.evaluate((tokens) => {
      for (const el of Array.from(document.querySelectorAll('#root *'))) for (const t of tokens) el.classList.remove(t);
    }, SQUEEZE_TOKENS);
  }
  await page.waitForTimeout(500);
  expect(thrown, 'no page error').toEqual([]);
}

const measure = (page: Page) => page.evaluate(() => {
  const vh = window.innerHeight;
  const r = (e: Element) => { const b = e.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, h: b.height, w: b.width }; };
  const frame = document.querySelector('[data-testid="flow-board-frame"]')!;
  const cols = Array.from(document.querySelectorAll('[data-board-column]')).map((col) => {
    const box = col.querySelector('div.overflow-y-auto') as HTMLElement;
    const card = col.querySelector('[data-story-card]');
    const b = box.getBoundingClientRect(); const c = card?.getBoundingClientRect();
    return {
      id: col.getAttribute('data-board-column'), boxH: Math.round(b.height), cardH: c ? Math.round(c.height) : null,
      cardWholeInBox: c ? c.top >= b.top - 0.5 && c.bottom <= b.bottom + 0.5 : null,
      cardWholeInWindow: c ? c.top >= 0 && c.bottom <= vh : null,
    };
  });
  const strips = Array.from(document.querySelectorAll('[data-trust-column]')).filter((s) => s.getAttribute('data-testid')?.startsWith('trust-column-strip')).map((s) => {
    const label = Array.from(s.querySelectorAll('span')).find((x) => getComputedStyle(x).writingMode.startsWith('vertical')) as HTMLElement;
    const sb = s.getBoundingClientRect(); const lb = label.getBoundingClientRect();
    const range = document.createRange(); range.selectNodeContents(label);
    const lines = new Set(Array.from(range.getClientRects()).map((q) => Math.round(q.left))).size; // vertical-rl: one text line = one distinct x
    const count = Array.from(s.querySelectorAll('span')).find((x) => x.classList.contains('tabular-nums'))!.getBoundingClientRect();
    return { id: s.getAttribute('data-trust-column'), text: (label.textContent ?? '').trim(), labelBottom: lb.bottom, countTop: count.top, stripH: Math.round(sb.height), fits: s.scrollHeight <= s.clientHeight + 0.5, labelInside: lb.top >= sb.top - 0.5 && lb.bottom <= sb.bottom + 0.5, lines };
  });
  const scroller = document.getElementById('scroller')!;
  return { vh, frameH: Math.round(r(frame).h), cols, strips, scrollerOverflow: scroller.scrollHeight - scroller.clientHeight, docOverflow: document.documentElement.scrollHeight - vh };
});

test('[SID:4923] positive control: with the three low-window paddings taken off, 1100×420 reproduces the dev numbers — column box 69px, card 78px, the first card cut', async ({ page }) => {
  await open(page, { viewport: [1100, 420], squeeze: 'off' });
  const m = await measure(page);
  expect(m.frameH, 'frame as on dev').toBe(206);
  const q = m.cols.find((c) => c.id === 'queued')!;
  expect(q.boxH).toBe(69);
  expect(q.cardH).toBe(78);
  expect(q.cardWholeInBox).toBe(false);
});

test('[SID:4923] 1100×420: every column box ≥ 90px and the first card of every column is WHOLE in its box and in the window — with the frame unchanged (206px) and the document not scrolling', async ({ page }) => {
  await open(page, { viewport: [1100, 420] });
  const m = await measure(page);
  expect(m.frameH, 'the frame is not touched (the support button room and the 4913 rules stay)').toBe(206);
  for (const c of m.cols) {
    expect(c.boxH, `${c.id}: box ${c.boxH}px`).toBeGreaterThanOrEqual(90);
    expect(c.cardWholeInBox, `${c.id}: first card whole in its box`).toBe(true);
    expect(c.cardWholeInWindow, `${c.id}: first card whole in the window`).toBe(true);
  }
  expect(m.cols.length).toBeGreaterThanOrEqual(3);
  expect(m.docOverflow, 'the document itself does not scroll').toBeLessThanOrEqual(0);
});

test('[SID:4923] 1100×420: the folded strips keep their vertical label on ONE line, inside the strip, and the whole strip (dot · label · 0) fits', async ({ page }) => {
  await open(page, { viewport: [1100, 420] });
  const m = await measure(page);
  expect(m.strips.length, 'the three locked columns are strips while empty').toBe(3);
  for (const s of m.strips) {
    expect(s.lines, `${s.text}: one line`).toBe(1);
    expect(s.labelInside, `${s.text}: inside the ${s.stripH}px strip`).toBe(true);
    expect(s.fits, `${s.text}: the whole strip fits its ${s.stripH}px`).toBe(true);
  }
});

test('[SID:4923] the English labels («Needs Input» · «Verified» · «Merge Ready» — longer than the Korean ones) fit the strip too', async ({ page }) => {
  await open(page, { viewport: [1100, 420] });
  await page.evaluate(() => {
    const en: Record<string, string> = { needs_input: 'Needs Input', verified: 'Verified', merge_ready: 'Merge Ready' };
    for (const s of Array.from(document.querySelectorAll('[data-testid^="trust-column-strip-"]'))) {
      const label = Array.from(s.querySelectorAll('span')).find((x) => getComputedStyle(x).writingMode.startsWith('vertical'))!;
      label.textContent = en[s.getAttribute('data-trust-column')!] ?? label.textContent;
    }
  });
  const m = await measure(page);
  expect(m.strips.length).toBe(3);
  for (const s of m.strips) {
    expect(s.lines, `${s.text}: one line`).toBe(1);
    expect(s.fits, `${s.text}: the whole strip fits its ${s.stripH}px`).toBe(true);
  }
});

test('[SID:4923] 1100×420, the classic 5-step axis: every column box ≥ 90px and the first card whole in its box and in the window too (the other column part)', async ({ page }) => {
  await open(page, { viewport: [1100, 420] });
  await page.getByText('5단계 클래식', { exact: true }).click();
  await page.locator('[data-board-column="backlog"]').waitFor();
  await page.waitForTimeout(300);
  const m = await measure(page);
  expect(m.cols.map((c) => c.id)).toContain('backlog');
  expect(m.frameH).toBe(206);
  for (const c of m.cols) {
    expect(c.boxH, `${c.id}: box ${c.boxH}px`).toBeGreaterThanOrEqual(90);
    if (c.cardH !== null) {
      expect(c.cardWholeInBox, `${c.id}: first card whole in its box`).toBe(true);
      expect(c.cardWholeInWindow, `${c.id}: first card whole in the window`).toBe(true);
    }
  }
});

test('[SID:4923] a strip with too little room (a window below 420px, browser zoom, a longer name) cuts its label with an ellipsis — never a second line, never over the count', async ({ page }) => {
  await open(page, { viewport: [1100, 420] });
  await page.evaluate(() => { for (const s of Array.from(document.querySelectorAll('[data-testid^="trust-column-strip-"]'))) (s as HTMLElement).style.height = '95px'; });
  const m = await measure(page);
  expect(m.strips.length).toBe(3);
  for (const s of m.strips) {
    expect(s.lines, `${s.text}: one line`).toBe(1);
    expect(s.labelBottom, `${s.text}: the label ends above the count`).toBeLessThanOrEqual(s.countTop + 0.5);
    expect(s.fits, `${s.text}: nothing — label or count — hangs out of the ${s.stripH}px strip (the label gives way instead)`).toBe(true);
  }
});

// a window taller than 520 gets none of the three paddings (nothing changes); the 520-high window (1280×520) gets them — a roomier box, never a smaller one
for (const vp of [[1440, 900], [1100, 800]] as Array<[number, number]>) {
  test(`[SID:4923] ${vp.join('×')}: untouched — the same column boxes with and without the low-window paddings`, async ({ page }) => {
    await open(page, { viewport: vp });
    const a = await measure(page);
    await open(page, { viewport: vp, squeeze: 'off' });
    const b = await measure(page);
    expect(a.frameH).toBe(vp[1] - 214);
    expect(a.cols.map((c) => c.boxH)).toEqual(b.cols.map((c) => c.boxH));
  });
}
test('[SID:4923] 1280×520: a roomier box than without the paddings (never smaller), the frame untouched', async ({ page }) => {
  await open(page, { viewport: [1280, 520] });
  const a = await measure(page);
  await open(page, { viewport: [1280, 520], squeeze: 'off' });
  const b = await measure(page);
  expect(a.frameH).toBe(520 - 214);
  expect(a.frameH).toBe(b.frameH);
  a.cols.forEach((c, i) => expect(c.boxH, `${c.id}`).toBeGreaterThan(b.cols[i]!.boxH));
});

const dragTo = async (page: Page, fromSel: string, toSel: string, opts?: { toBottom?: boolean }) => {
  const from = (await page.locator(fromSel).first().boundingBox())!;
  await page.mouse.move(from.x + 40, from.y + 20);
  await page.mouse.down();
  await page.mouse.move(from.x + 52, from.y + 24, { steps: 4 });
  const target = page.locator(toSel).first();
  for (let i = 0; i < 40; i += 1) { // bring the target column into view the way a person does: keep the pointer near the board's edge while it scrolls
    const t = await target.boundingBox();
    const rowBox = (await page.locator('[data-board-column]').first().evaluate((e) => (e.parentElement as HTMLElement).getBoundingClientRect().toJSON())) as { left: number; right: number };
    if (t && t.x >= rowBox.left && t.x + 60 <= rowBox.right) break;
    await page.mouse.move(rowBox.right - 6, from.y + 24, { steps: 3 });
    await page.waitForTimeout(100);
  }
  // the target is in view; pull the pointer back from the edge (so the sideways auto-scroll stops), then aim at where the target column is NOW and check the pointer really is over it before letting go
  const rowBox = (await page.locator('[data-board-column]').first().evaluate((e) => (e.parentElement as HTMLElement).getBoundingClientRect().toJSON())) as { left: number; right: number };
  await page.mouse.move((rowBox.left + rowBox.right) / 2, from.y + 24, { steps: 6 });
  const targetId = await target.getAttribute('data-board-column');
  let over = false;
  for (let i = 0; i < 12 && !over; i += 1) {
    await page.waitForTimeout(200);
    const t = (await target.boundingBox())!;
    const y = opts?.toBottom ? t.y + t.height - 12 : t.y + Math.min(t.height / 2, 60);
    // the point inside the target column that is also inside the visible row (the column may be partly scrolled out)
    const x = Math.min(Math.max(t.x + t.width / 2, Math.max(t.x, rowBox.left) + 20), Math.min(t.x + t.width, rowBox.right) - 20);
    await page.mouse.move(x, y, { steps: 6 });
    await page.waitForTimeout(250);
    // no fixed guess: the pointer is released only when the element under it is really the target column and the row has stopped moving
    const before = (await target.boundingBox())!.x;
    await page.waitForTimeout(150);
    const after = (await target.boundingBox())!.x;
    over = Math.abs(after - before) < 1 && (await page.evaluate(([px, py, id]) => document.elementsFromPoint(px as number, py as number).some((e) => e.closest(`[data-board-column="${id}"]`)), [x, y, targetId] as const));
  }
  expect(over, `the pointer is over the target column ${targetId} before it is released`).toBe(true);
  await page.mouse.up();
  await page.waitForTimeout(300);
};
const writes = (page: Page) => page.evaluate(() => (window as unknown as { __writes: Array<{ method: string; url: string; body: string }> }).__writes);

test('[SID:4923] 1100×420 + page scrolled: dragging a card to the next column still moves it (status → in-progress)', async ({ page }) => {
  await open(page, { viewport: [1100, 420] });
  await page.locator('#scroller').evaluate((e) => { e.scrollTop = 30; });
  await dragTo(page, '[data-board-column="queued"] [data-story-card]', '[data-board-column="running"]');
  const w = await writes(page);
  expect(w.some((x) => x.method !== 'GET' && /in-progress/.test(x.body)), JSON.stringify(w)).toBe(true);
});

test('[SID:4923] 1100×420: dragging a card across to a column that is off to the right (the row scrolls sideways) and to the END of that column still moves it (status → in-review)', async ({ page }) => {
  await open(page, { viewport: [1100, 420] });
  await dragTo(page, '[data-board-column="queued"] [data-story-card]', '[data-board-column="claimed_done"]', { toBottom: true });
  const w = await writes(page);
  expect(w.some((x) => x.method !== 'GET' && /in-review/.test(x.body)), JSON.stringify(w)).toBe(true);
});

// the keyboard move: Space lifts, → goes to the next column, Space drops. Cases: a low window (page scrolled and not), a tall window (control), and a low window without the 4923 paddings (control) — a result the same in all of them is the board's own behaviour, not the paddings'
const KEY_CASES: Array<{ name: string; viewport: [number, number]; squeeze?: 'off'; scroll: number }> = [
  { name: '1100×420, page scrolled', viewport: [1100, 420], scroll: 30 },
  { name: '1100×420, page not scrolled', viewport: [1100, 420], scroll: 0 },
  { name: '1440×900 (control)', viewport: [1440, 900], scroll: 0 },
  { name: '1100×420 WITHOUT the paddings (control)', viewport: [1100, 420], squeeze: 'off', scroll: 0 },
];
for (const c of KEY_CASES) {
  test(`[SID:4923] keyboard move (Space · → · Space) at ${c.name}`, async ({ page }) => {
    await open(page, { viewport: c.viewport, squeeze: c.squeeze });
    if (c.scroll) await page.locator('#scroller').evaluate((e, y) => { e.scrollTop = y; }, c.scroll);
    const card = page.locator('[data-board-column="queued"] [data-story-card]').first();
    await card.focus();
    await card.press('Space'); // lift
    await page.waitForTimeout(250);
    // → until the place the board announces is in the next column (a card of it — 카드 8 · 9 · 10 — or the column itself): the first → may land on the card below in the same column, that is the board's own coordinate rule
    const announced = () => page.evaluate(() => Array.from(document.querySelectorAll('[aria-live]')).map((e) => (e.textContent ?? '').trim()).filter(Boolean).join(' | '));
    const trail: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      await card.press('ArrowRight');
      await page.waitForTimeout(250);
      const a = await announced();
      trail.push(a);
      if (/지금 자리: (카드 (8|9|10)|실행 중)/.test(a)) break;
    }
    const said = trail.join(' → ');
    await card.press('Space'); // drop
    await page.waitForTimeout(500);
    const w = await writes(page);
    expect(w.some((x) => x.method !== 'GET' && /in-progress/.test(x.body)), `${JSON.stringify(w)} · announced: ${said}`).toBe(true);
  });
}

test('[SID:4923] the board frame is the one 4923 already had (8px above and below on a low window) — no height floor on it', () => {
  const cls = frameClassFull();
  expect(cls).toContain('py-4');
  expect(cls).toContain('lg:[@media(max-height:520px)]:py-2');
  expect(cls).not.toContain(':h-[max(');
});
