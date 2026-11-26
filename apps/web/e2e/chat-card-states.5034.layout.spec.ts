/**
 * story 5034 (C4) — the chat card, measured in Chromium with the REAL components (bundled with esbuild) and the real Tailwind build of globals.css; nothing is signed in, no server runs.
 * The rule: in every one of its states (default · loading · empty · error · not visible · long text) the card stays inside its column at 390 and at 1440, in light and in dark; a long
 * title is cut at two lines instead of widening the card; the retry button is a ds Button (≥ 44 on touch). The pictures of every state in both themes and both widths go to
 * `~/.sprintable-shared/nwachukwu/5034/shots/` (a plain folder of PNGs — the PO looks at them).
 */
import { mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { compile, optimize } from '@tailwindcss/node';
import { layoutStubPlugin } from './support/layout-stubs';
import { tailwindCandidates } from './support/tailwind-candidates';

const req = createRequire(__filename);
const WEB = path.join(__dirname, '..');
const APP = path.join(WEB, 'src', 'app');
const SHOTS = path.join(os.homedir(), '.sprintable-shared', 'nwachukwu', '5034', 'shots');

let built: { js: string; css: string } | null = null;
async function build() {
  if (built) return built;
  const esbuild = req('esbuild') as typeof import('esbuild');
  const bodies: Record<string, string> = {
    '@/components/realtime-provider': 'export function useSseMultiplexerContext() { return { subscribe: () => () => {} }; }',
    '@/app/dashboard/dashboard-shell': "export function useDashboardContext() { return { orgId: 'org-1', currentTeamMemberId: 'me-1', projectId: 'p1', role: 'member', currentMemberType: 'human', projectMemberships: [] }; }",
  };
  const filter = new RegExp(`^(${Object.keys(bodies).map((k) => k.replace(/[/.-]/g, '\\$&')).join('|')})$`);
  const out = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react'; import { createRoot } from 'react-dom/client'; import { NextIntlClientProvider } from 'next-intl';
        import ko from './messages/ko.json';
        import { CardStatesShowcase } from './src/components/chat/cards/card-states-showcase';
        import { CardFrame } from './src/components/chat/cards/card-frame';
        import { EntityCardFace } from './src/components/chat/cards/entity-card';
        import { KanbanCardFace } from './src/components/chat/cards/kanban-card';
        const LONG = ko.chats.cardSampleLong;
        window.__mountShowcase = () => {
          createRoot(document.getElementById('root')).render(React.createElement(NextIntlClientProvider, { locale: 'ko', messages: ko, timeZone: 'Asia/Seoul' }, React.createElement(CardStatesShowcase)));
        };
        // the sprint board card (a long title · all 73 stories done) in a column of the given width
        window.__mountKanban = (w) => {
          const h = React.createElement;
          const summary = { title: 'Sprint 12 — Backlog Clearance 처럼 아주 아주 긴 이름의 스프린트', status: 'closed', total: 73, counts: { backlog: 0, 'ready-for-dev': 0, 'in-progress': 0, 'in-review': 0, done: 73 }, now: [], hasMore: false };
          createRoot(document.getElementById('root')).render(h(NextIntlClientProvider, { locale: 'ko', messages: ko, timeZone: 'Asia/Seoul' },
            h('div', { id: 'col', style: { width: w + 'px', padding: '12px', boxSizing: 'border-box' }, className: 'bg-ds-background' },
              h('div', { 'data-case': 'kanban' }, h(KanbanCardFace, { summary })))));
        };
        // every state, stacked, in a column of the given width (what the pictures show)
        window.__mountAll = (w) => {
          const h = React.createElement;
          const cap = (t) => h('div', { style: { fontSize: '12px', margin: '8px 0 4px' }, className: 'text-ds-ink-3' }, t);
          createRoot(document.getElementById('root')).render(h(NextIntlClientProvider, { locale: 'ko', messages: ko, timeZone: 'Asia/Seoul' },
            h('div', { id: 'col', style: { width: w + 'px', padding: '12px', boxSizing: 'border-box' }, className: 'bg-ds-background' },
              cap(ko.chats.cardStateReady), h('div', { 'data-case': 'ready' }, h(EntityCardFace, { kind: 'story', title: ko.chats.cardSampleTitle, statusLabel: ko.chats.cardSampleStatus, onOpen() {} })),
              cap(ko.chats.cardStateLoading), h('div', { 'data-case': 'loading' }, h(CardFrame, { state: 'loading' })),
              cap(ko.chats.cardStateEmpty), h('div', { 'data-case': 'empty' }, h(CardFrame, { state: 'empty' })),
              cap(ko.chats.cardStateError), h('div', { 'data-case': 'error' }, h(CardFrame, { state: 'error', onRetry() {} })),
              cap(ko.chats.cardStateHidden), h('div', { 'data-case': 'hidden' }, h(CardFrame, { state: 'hidden' })),
              cap(ko.chats.cardStateLong), h('div', { 'data-case': 'long' }, h(EntityCardFace, { kind: 'doc', title: LONG, statusLabel: ko.chats.cardSampleStatus, onOpen() {} })))));
        };`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_APP_URL': '"https://app.sprintable.ai"' },
    plugins: [
      { name: 'cards-5034-stubs', setup(b) {
        b.onResolve({ filter }, (a) => ({ path: a.path, namespace: 'cards5034' }));
        b.onLoad({ filter: /.*/, namespace: 'cards5034' }, (a) => ({ contents: bodies[a.path]!, loader: 'js', resolveDir: WEB }));
      } },
      layoutStubPlugin(),
    ],
  });
  const js = out.outputFiles[0]!.text;
  const candidates = tailwindCandidates(js);
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  const css = (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(candidates), { minify: false }).code;
  built = { js, css };
  return built;
}

async function open(page: Page, width: number, dark: boolean, mount: 'all' | 'showcase' | 'kanban') {
  const { js, css } = await build();
  await page.setViewportSize({ width: Math.max(width, 320), height: 1100 });
  await page.unrouteAll();
  await page.route('http://preview.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ko" class="${dark ? 'dark' : ''}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-background text-foreground" style="margin:0"><div id="root"></div></body></html>` });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [] }) });
  });
  await page.goto('about:blank');
  await page.goto('http://preview.test/');
  await page.addScriptTag({ content: js });
  await page.evaluate(([m, w]) => {
    const win = window as unknown as { __mountAll: (w: number) => void; __mountShowcase: () => void; __mountKanban: (w: number) => void };
    return m === 'all' ? win.__mountAll(w as number) : m === 'kanban' ? win.__mountKanban(w as number) : win.__mountShowcase();
  }, [mount, width] as const);
  await page.locator(mount === 'all' ? '[data-case="long"]' : mount === 'kanban' ? '[data-case="kanban"]' : '[data-testid="chat-card-states-showcase"]').waitFor();
  await page.waitForTimeout(200);
}

/** every box inside the column stays inside it */
const outside = (page: Page, rootSel: string) => page.evaluate((sel) => {
  const col = (document.querySelector(sel) as HTMLElement).getBoundingClientRect();
  const out: string[] = [];
  for (const el of document.querySelectorAll(`${sel} *`)) {
    const r = (el as HTMLElement).getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) continue; // a 1 × 1 off-screen part (sr-only) is not a visible part
    if (r.right > col.right + 0.5 || r.left < col.left - 0.5) out.push(`${el.tagName.toLowerCase()} ${Math.round(r.left - col.left)}..${Math.round(r.right - col.left)} of ${Math.round(col.width)}`);
  }
  return { out, scroll: [document.documentElement.scrollWidth, document.documentElement.clientWidth] };
}, rootSel);

for (const width of [390, 1440]) {
  for (const dark of [false, true]) {
    const tag = `${width}-${dark ? 'dark' : 'light'}`;
    test.describe(`cards ${tag}`, () => {
      test.use(width === 390 ? { hasTouch: true, isMobile: true } : {});
      test(`[SID:5034] every state stays inside its column; the long title is cut at two lines (${tag})`, async ({ page }) => {
        mkdirSync(SHOTS, { recursive: true });
        await open(page, width, dark, 'all');
        const m = await outside(page, '#col');
        expect(m.out, `running past the column: ${m.out.join(' | ')}`).toEqual([]);
        expect(m.scroll[0], 'no horizontal overflow').toBeLessThanOrEqual(m.scroll[1]);
        const long = await page.evaluate(() => {
          const t = document.querySelector('[data-case="long"] span.line-clamp-2') as HTMLElement;
          const lh = parseFloat(getComputedStyle(t).lineHeight);
          return { h: t.getBoundingClientRect().height, lh, textLen: t.textContent!.length };
        });
        expect(long.textLen).toBeGreaterThan(100);
        expect(long.h, 'cut at two lines').toBeLessThanOrEqual(long.lh * 2 + 1); // reverted (no clamp) → the title is four lines tall at 390 → fails
        if (width === 390) {
          const retry = await page.locator('[data-case="error"] button').boundingBox();
          expect(retry!.height, 'the retry button on touch is at least 44 high').toBeGreaterThanOrEqual(44);
          expect(retry!.width).toBeGreaterThanOrEqual(44);
        }
        await page.screenshot({ path: path.join(SHOTS, `cards-states-${tag}.png`), fullPage: true });
      });
    });
  }
}

test('[SID:5034] the state toggle: every button shows its state, 390 and 1440 change the stage (one picture of the toggle itself)', async ({ page }) => {
  mkdirSync(SHOTS, { recursive: true });
  await open(page, 1440, false, 'showcase');
  const stage = page.locator('[data-testid="chat-card-states-stage"]');
  await expect(stage).toHaveCSS('width', '390px');
  for (const [label, state] of [['로딩', 'loading'], ['비어 있음', 'empty'], ['오류', 'error'], ['볼 수 없음', 'hidden'], ['긴 글', 'ready'], ['기본', 'ready']] as const) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await expect(stage.locator('[data-card-state]')).toHaveAttribute('data-card-state', state);
  }
  await page.getByRole('button', { name: '1440 폭' }).click();
  await expect(stage).toHaveCSS('width', '1440px');
  const w = await stage.locator('[data-card-state]').evaluate((e) => e.getBoundingClientRect().width);
  expect(w).toBeLessThanOrEqual(1440);
  await page.screenshot({ path: path.join(SHOTS, 'cards-state-toggle-1440-light.png'), fullPage: true });
});

// the board card at the width the PO saw it break (a 390 phone room leaves the card ~214 wide) · and wide
for (const colWidth of [238, 390, 1440]) {
  test(`[SID:5034] the board card at a ${colWidth}-wide column: no label breaks letter by letter, the title is one line, nothing runs past the column`, async ({ page }) => {
    mkdirSync(SHOTS, { recursive: true });
    await open(page, Math.max(colWidth, 390), false, 'kanban');
    // `open` sizes the viewport to ≥ 390; the COLUMN is what changes (`__mountKanban(w)`) — the card reads its own width, never the screen's
    await page.evaluate((w) => { (document.getElementById('col') as HTMLElement).style.width = `${w}px`; }, colWidth);
    await page.waitForTimeout(100);
    const m = await outside(page, '#col');
    expect(m.out, `running past the column: ${m.out.join(' | ')}`).toEqual([]);
    const r = await page.evaluate(() => {
      const card = document.querySelector('[data-case="kanban"]') as HTMLElement;
      const title = Array.from(card.querySelectorAll('span')).find((s) => s.className.includes('truncate')) as HTMLElement;
      const lh = (e: HTMLElement) => parseFloat(getComputedStyle(e).lineHeight);
      const labels = Array.from(card.querySelectorAll('[data-column] span:first-child')) as HTMLElement[];
      const lis = Array.from(card.querySelectorAll('[data-column]')) as HTMLElement[];
      return {
        titleH: title.getBoundingClientRect().height, titleLh: lh(title),
        labelMax: Math.max(...labels.map((l) => l.getBoundingClientRect().height / lh(l))),
        // narrow: one wrapping line = the five pairs are not boxed (no border) · wide: five boxes in ONE row
        boxed: getComputedStyle(lis[0]!).borderTopWidth !== '0px',
        rows: new Set(lis.map((l) => Math.round(l.getBoundingClientRect().top))).size,
        totalFits: (() => { const t = Array.from(card.querySelectorAll('span')).find((s) => s.textContent?.includes('73개')) as HTMLElement; const row = t.parentElement!.getBoundingClientRect(); const b = t.getBoundingClientRect(); return b.right <= row.right + 0.5 && b.height <= lh(t) + 1; })(),
      };
    });
    expect(r.titleH, 'the board title is one line').toBeLessThanOrEqual(r.titleLh + 1);
    expect(r.labelMax, 'a column label is never taller than 1.5 lines (a label broken letter by letter is 3+)').toBeLessThanOrEqual(1.5);
    expect(r.totalFits, 'the count «장 73개» stays on one line inside the head').toBe(true);
    if (colWidth < 448) { expect(r.boxed, 'narrow: no boxes').toBe(false); }
    else { expect(r.boxed, 'wide: five boxes').toBe(true); expect(r.rows, 'wide: the five boxes stand in one row').toBe(1); }
    await page.screenshot({ path: path.join(SHOTS, `board-card-${colWidth}.png`), fullPage: true });
  });
}
