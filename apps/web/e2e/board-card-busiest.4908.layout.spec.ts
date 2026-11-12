/**
 * story 4908 — the board card in its busiest state, measured in Chromium with the REAL component (bundled here with esbuild, not copied) and the real Tailwind build of globals.css.
 * The rule (PO 11-12): even when every piece of the card is present — category · epic · three labels · a line badge · the last run · points · the seal · four assignees — the card
 * never spills out of its box (scrollWidth = clientWidth, scrollHeight = clientHeight) and is at most 96px tall, at the narrowest column (240 → a 202px card), the default column
 * (280 → 242px) and the phone (390 → 358px). Nothing grows a line: the meta row is a fixed 20px, the lower-priority pieces at its end are clipped and every one of them is
 * in the tooltip of the clipped group. No server and no sign-in (the layout config) — the page is made here.
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
        import { DndContext } from '@dnd-kit/core';
        import ko from './messages/ko.json';
        import { StoryCard } from './src/components/kanban/story-card';
        window.__mountCard = (width, props) => createRoot(document.getElementById('root')).render(
          React.createElement(NextIntlClientProvider, { locale: 'ko', messages: ko, timeZone: 'Asia/Seoul' },
            React.createElement(DndContext, null,
              React.createElement('div', { id: 'wrap', style: { width: width + 'px' } },
                React.createElement(StoryCard, { onClick: () => {}, onChangeStatus: () => {}, ...props })))));`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'), define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [layoutStubPlugin()],
  });
  const js = out.outputFiles[0]!.text;
  // every class the bundle can render — the strings in it (double · single · template quoted, `${…}` holes dropped), split; unknown tokens are ignored by the compiler
  const flat = js.replace(/\$\{[^}]*\}/g, ' ');
  const candidates = [...new Set([...flat.matchAll(/[`"']([^`"'\n]+)[`"']/g)].flatMap((m) => m[1]!.split(/\s+/)).filter(Boolean))];
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  const css = (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(candidates), { minify: false }).code;
  built = { js, css };
  return built;
}

async function open(page: Page, o: { width: number; theme: 'L' | 'D'; cardWidth: number; props: Record<string, unknown> }) {
  const { js, css } = await build();
  await page.setViewportSize({ width: o.width, height: 900 });
  await page.route('http://preview.test/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html lang="ko" class="${o.theme === 'D' ? 'dark' : ''}"><head><meta charset="utf-8"><style>${css}</style></head><body class="bg-ds-background text-ds-ink"><div style="padding:16px"><div id="root"></div></div></body></html>`,
  }));
  await page.goto('http://preview.test/');
  const thrown: string[] = [];
  page.on('pageerror', (e) => thrown.push(e.message));
  await page.addScriptTag({ content: js });
  if (!(await page.evaluate(() => typeof (window as unknown as { __mountCard?: unknown }).__mountCard === 'function'))) {
    throw new Error(`the bundle did not start — likely a module to stub (STUBS): ${thrown.join(' | ') || 'no page error'}`);
  }
  await page.evaluate(([w, p]) => (window as unknown as { __mountCard: (w: number, p: unknown) => void }).__mountCard(w as number, p), [o.cardWidth, o.props] as const);
  await page.locator('#wrap > div').waitFor();
}

const member = (id: string, name: string, type: 'human' | 'agent') => ({ id, name, type });
const BUSIEST = {
  story: {
    id: 's1', story_number: 4908, status: 'done', priority: 'medium', story_points: 5, epic_id: 'e1', assignee_id: 'm1', assignee_ids: ['m1', 'm2', 'm3', 'm4'],
    title: '[Workcell·콘텐츠 ③] goal/DoD 구조화 소스 트랙 — 제목이 아주 길어서 두 줄을 넘기려는 카드라도 세 줄이 되면 안 된다', self_reported: true, human_verified: false,
  },
  epicName: '첫 경험 · 가입 온보딩 계정 화면 전체 다시 짓기',
  assignees: [member('m1', '안나', 'human'), member('m2', '빌드 에이전트', 'agent'), member('m3', '카를로스', 'human'), member('m4', '디디 에이전트', 'agent')],
  labels: [{ id: 'l1', name: '디자인 바탕', color: '#3E7DC2' }, { id: 'l2', name: '첫 경험', color: '#4C9A6A' }, { id: 'l3', name: '글', color: '#B59A3C' }],
  blockedBy: ['x1', 'x2'],
  lineStatus: { story_id: 's1', has_active: true, mode: 'x', status: 'running', engine_degraded: true, grandfathered: false, handoff_stuck: false, delivery_status: null },
  lastExecution: { status: 'matched', rule_name: '킥오프 규칙', completed_at: '2026-11-12T01:00:00Z' },
  projectId: 'p1',
};

// the narrowest column (240 − 2×12 padding − 2×6 list padding − 2 border = 202) · the default column (280 → 242) · the phone list (390 − gutters → 358)
const WIDTHS: Array<[string, number, number]> = [['column min 240', 1440, 202], ['column 280', 1440, 242], ['phone 390', 390, 358]];

for (const theme of ['L', 'D'] as const) for (const [label, viewport, cardWidth] of WIDTHS) {
  test(`[4908] the busiest card stays in its box and ≤ 96px · ${label} · ${theme}`, async ({ page }) => {
    await open(page, { width: viewport, theme, cardWidth, props: BUSIEST });
    const card = page.locator('#wrap > div');
    const m = await card.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const meta = el.querySelector<HTMLElement>('[data-testid="story-card-meta-lead"]')!;
      const row = meta.parentElement!.getBoundingClientRect();
      const lead = meta.getBoundingClientRect();
      return {
        width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10, scrollW: el.scrollWidth, clientW: el.clientWidth, scrollH: el.scrollHeight, clientH: el.clientHeight,
        metaRowH: Math.round(row.height * 10) / 10, leadW: Math.round(lead.width), leadScrollW: meta.scrollWidth, title: meta.getAttribute('title') ?? '',
        // any painted descendant that sticks out of the card to the right (a clipped one is cut by its own overflow-hidden parent, so its rect still counts — only unclipped spill is a defect)
        spill: [...el.querySelectorAll<HTMLElement>('*')].filter((n) => {
          if (n.closest('[data-testid="story-card-meta-lead"]') && n !== meta) return false; // clipped by the lead group
          if (n.closest('.sr-only')) return false;
          return n.getBoundingClientRect().right > r.right + 0.5;
        }).length,
      };
    });
    console.log(`BOARD_CARD_BUSIEST ${label} ${theme} card=${m.width}x${m.height} scroll=${m.scrollW}/${m.clientW} metaRow=${m.metaRowH} lead=${m.leadW}/${m.leadScrollW}`);
    expect(m.scrollW, 'no sideways spill').toBe(m.clientW);
    expect(m.scrollH, 'no downward spill').toBe(m.clientH);
    expect(m.spill, 'nothing painted past the card edge').toBe(0);
    expect(m.height, 'card height').toBeLessThanOrEqual(96);
    expect(m.metaRowH, 'the meta row is a fixed 20px').toBe(20);
    // what is clipped is not lost: the lead group's tooltip names the category · epic · every label · the line badge · the last run
    for (const needle of ['Workcell·콘텐츠 ③', '첫 경험 · 가입', '디자인 바탕, 첫 경험, 글', '킥오프 규칙']) expect(m.title, needle).toContain(needle);
  });
}

test('[4908] the card with everything present still shows who and how much (points · seal · assignees are never clipped)', async ({ page }) => {
  await open(page, { width: 1440, theme: 'L', cardWidth: 202, props: BUSIEST });
  const card = page.locator('#wrap > div');
  const seal = card.getByTestId('story-card-seal');
  await expect(seal).toHaveAttribute('data-seal', 'claimed');
  const inside = await card.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const seal = el.querySelector('[data-testid="story-card-seal"]')!.getBoundingClientRect();
    return seal.right <= r.right && seal.left >= r.left;
  });
  expect(inside).toBe(true);
});
