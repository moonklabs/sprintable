/**
 * story 5051 — the activity row (ProofCapsule density="audit"), measured in Chromium with the REAL component (bundled with esbuild, not copied) and the real Tailwind build of globals.css; no server, no sign-in.
 *
 * What failed in CI (run 45923586779, /activity @402): the row's «time · actor» chunk was `shrink-0` with no ellipsis, so a long actor label — a long agent name, or the «· ID 8 chars» tail that two members with the SAME name get —
 * pushed the list's scroller to 413 on a 402 screen. Measured on Linux with the seeds stacked (run 45931972599): that chunk was 320 px wide and the row 403.
 *
 * The rule, read from BOXES (not text widths — Mac and Linux draw Korean in the mono face at different widths, so a long label here is long on both):
 *  · a narrow row never runs past its column, and the claim keeps at least 200 px (an ellipsis alone would leave it ~80 px);
 *  · when the meta group (avatar + «time · actor») does not fit beside the claim it drops to a second line, and the label inside it is ellipsized;
 *  · the same row in the goal page's 288 px trust rail stays one line, and in a rail narrower than the floor the floor yields (nothing runs past the rail);
 *  · a row with nothing but a time stays on the claim's line at 402 (the wrap is not «always»); a wide row is one line with nothing cut.
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

const TAIL_LABEL = '넘침 가드 에이전트 · 889ac232';                                                    // the row of CI: a same-name tail
const LONG_LABEL = '아주 긴 이름을 가진 검수 에이전트 구성원 · 같은 이름이 둘 이상이라 꼬리가 붙은 경우 · 889ac232';  // far longer than any screen here
const UNBROKEN = 'AReallyLongUnbrokenTokenWithoutAnySpacesThatCannotWrapAnywhereInTheLayoutAtAll_0123456789_abcdefghijklmnopqrstuvwxyz';

let built: { js: string; css: string } | null = null;
async function build() {
  if (built) return built;
  const esbuild = req('esbuild') as typeof import('esbuild');
  const out = await esbuild.build({
    stdin: {
      contents: `
        import React from 'react'; import { createRoot } from 'react-dom/client'; import { NextIntlClientProvider } from 'next-intl';
        import ko from './messages/ko.json';
        import { ProofCapsule } from './src/components/proof-capsule/proof-capsule';
        const rows = [
          { claim: 'story · 넘침 가드 채움 스토리 16', now: '1분 전', agent: { name: '넘침 가드 에이전트', label: ${JSON.stringify(TAIL_LABEL)} }, kind: 'tail' },
          { claim: 'doc · [FE·prod 승격 준비] 명령 팔레트 «작업 목록»이 /work-list(직접 경로)로 보내는데 옛 주소 변환 표에 없어 404가 난다', now: '3분 전', agent: { name: '넘침 가드 에이전트', label: ${JSON.stringify(TAIL_LABEL)} }, kind: 'tail' },
          { claim: 'story · ' + ${JSON.stringify(UNBROKEN)}, now: '방금 전', human: { name: '유나', role: 'human' }, kind: 'short' },
          { claim: 'story · 넘침 가드 채움 스토리 3', now: '2시간 전', agent: { name: '검수', label: ${JSON.stringify(LONG_LABEL)} }, kind: 'long' },
          { claim: 'doc · 기획', now: '어제', human: { name: '유나', role: 'human' }, kind: 'short' },
          { claim: 'doc · 분기 계획 문서 모음', now: '어제', kind: 'time' },
        ];
        // the goals page's trust rail (goals/goal-trust-rail.tsx): a judged outcome is ONE audit row with no time and an EMPTY human name — only the avatar is in the meta group
        window.__mountRail = (w) => {
          const h = React.createElement;
          createRoot(document.getElementById('root')).render(h(NextIntlClientProvider, { locale: 'ko', messages: ko, timeZone: 'Asia/Seoul' },
            h('div', { id: 'col', style: { width: w + 'px', boxSizing: 'border-box' } },
              h('div', { 'data-row': 0 }, h(ProofCapsule, { proofState: 'green', stateLabel: '결과', claim: '결과 확정 · 적중', now: '', human: { name: '', role: '' }, density: 'audit' })),
              h('div', { 'data-row': 1 }, h(ProofCapsule, { proofState: 'blue', stateLabel: '결과', claim: '결과 확정 · 측정할 수 없음 · 목표를 다시 정해 주세요', now: '', human: { name: '', role: '' }, density: 'audit' })))));
        };
        window.__mount = (w) => {
          const h = React.createElement;
          const list = []; for (let i = 0; i < 30; i++) list.push(rows[i % rows.length]);
          createRoot(document.getElementById('root')).render(h(NextIntlClientProvider, { locale: 'ko', messages: ko, timeZone: 'Asia/Seoul' },
            h('div', { id: 'col', style: { width: w + 'px', padding: '0 24px', boxSizing: 'border-box', overflowX: 'auto' } },
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } }, list.map((r, i) =>
                h('div', { key: i, 'data-row': i, 'data-kind': r.kind }, h(ProofCapsule, { proofState: 'blue', stateLabel: 'story_created', claim: r.claim, now: r.now, human: r.human, agent: r.agent, density: 'audit' })))))));
        };`,
      resolveDir: WEB, loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'automatic',
    tsconfig: path.join(WEB, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_APP_URL': '"https://app.sprintable.ai"' },
    plugins: [layoutStubPlugin()],
  });
  const js = out.outputFiles[0]!.text;
  const candidates = tailwindCandidates(js);
  const compiler = await compile(readFileSync(path.join(APP, 'globals.css'), 'utf8'), { base: APP, onDependency: () => {} });
  const css = (optimize as unknown as (c: string, o?: object) => { code: string })(compiler.build(candidates), { minify: false }).code;
  built = { js, css };
  return built;
}

async function open(page: Page, width: number, mount: '__mount' | '__mountRail' = '__mount') {
  const { js, css } = await build();
  await page.setViewportSize({ width, height: 900 });
  await page.setContent(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-background text-foreground"><div id="root"></div></body></html>`);
  await page.addScriptTag({ content: js });
  await page.evaluate(([w, fn]) => (window as unknown as Record<string, (w: number) => void>)[fn as string]!(w as number), [width, mount] as const);
  await page.locator('[data-row="0"]').waitFor();
  await page.waitForTimeout(300);
}

type RowBox = { kind: string; rowRight: number; rowH: number; claimW: number; claimTop: number; claimBottom: number; metaTop: number; metaRight: number; chunkEllipsis: boolean; chunkCut: boolean; chunkW: number };
const measure = (page: Page) => page.evaluate(() => {
  const col = document.getElementById('col')!;
  const colBox = col.getBoundingClientRect();
  const rows = [...document.querySelectorAll<HTMLElement>('[data-row]')].map((el): RowBox => {
    const row = el.firstElementChild as HTMLElement;
    const claim = row.children[1] as HTMLElement;                                  // the row's children: dot · claim · meta group
    const meta = row.querySelector<HTMLElement>('[data-slot="audit-row-meta"]')!;
    const chunk = meta.querySelector<HTMLElement>('.font-mono')!;
    const r = row.getBoundingClientRect(), c = claim.getBoundingClientRect(), m = meta.getBoundingClientRect();
    return { kind: el.dataset.kind ?? '', rowRight: r.right, rowH: r.height, claimW: c.width, claimTop: c.top, claimBottom: c.bottom, metaTop: m.top, metaRight: m.right,
      chunkEllipsis: getComputedStyle(chunk).textOverflow === 'ellipsis', chunkCut: chunk.scrollWidth > chunk.clientWidth + 1, chunkW: chunk.getBoundingClientRect().width };
  });
  return { colRight: colBox.right - 24, scroll: [col.scrollWidth, col.clientWidth], docScroll: [document.documentElement.scrollWidth, document.documentElement.clientWidth], rows };
});

for (const width of [402, 320]) {
  test(`[SID:5051] @${width} — 30 rows with long actor labels: nothing runs past the column, the claim keeps ≥ 200 px, the long label goes to a second line and is ellipsized, a time-only row stays on the claim's line`, async ({ page }) => {
    await open(page, width);
    const m = await measure(page);
    expect(m.scroll[0], 'the column does not scroll sideways').toBeLessThanOrEqual(m.scroll[1]);
    expect(m.docScroll[0], 'the page does not scroll sideways').toBeLessThanOrEqual(m.docScroll[1]);
    expect(m.rows).toHaveLength(30);
    for (const r of m.rows) {
      expect(r.rowRight, `${r.kind} row inside the column`).toBeLessThanOrEqual(m.colRight + 0.5);
      expect(r.metaRight, `${r.kind} meta group inside its row`).toBeLessThanOrEqual(r.rowRight + 0.5);
      expect(r.claimW, `${r.kind} claim keeps its floor`).toBeGreaterThanOrEqual(200);
      if (r.kind === 'time') { if (width >= 402) expect(r.metaTop, 'a time with no actor stays on the claim\'s line').toBeLessThan(r.claimBottom); }   // at 320 the 13rem claim leaves ~40 px: it may wrap, and that is fine
      else if (r.kind === 'short') { /* a short name may or may not fit beside a 13rem claim at this width — both are fine; what is held is above (inside the column, claim floor) */ }
      else {
        expect(r.metaTop, `${r.kind} label drops under the claim`).toBeGreaterThanOrEqual(r.claimBottom - 1);
        expect(r.chunkEllipsis, `${r.kind} label has an ellipsis rule`).toBe(true);
      }
      if (r.kind === 'long') expect(r.chunkCut, 'the far-too-long label is actually cut').toBe(true);
    }
  });
}

test(`[SID:5051] @1440 — a wide row is one line, nothing cut`, async ({ page }) => {
  await open(page, 1440);
  const m = await measure(page);
  expect(m.scroll[0]).toBeLessThanOrEqual(m.scroll[1]);
  for (const r of m.rows) {
    expect(r.metaTop, `${r.kind} stays on the claim's line`).toBeLessThan(r.claimBottom);
    expect(r.chunkCut, `${r.kind} label is whole`).toBe(false);
  }
});

// the second place the audit row is used: the goal page's trust rail — a 328 px column (lg:grid-cols-[1fr_328px]) minus `lg:pl-6` and the list's `pl-4` = 288 px; a judged outcome is one row with no time and an empty name
const measureRail = (page: Page) => page.evaluate(() => {
  const col = document.getElementById('col')!.getBoundingClientRect();
  return [...document.querySelectorAll<HTMLElement>('[data-row]')].map((el) => {
    const row = el.firstElementChild as HTMLElement;
    const claim = row.children[1] as HTMLElement;
    const meta = row.querySelector<HTMLElement>('[data-slot="audit-row-meta"]');
    const r = row.getBoundingClientRect(), c = claim.getBoundingClientRect(), m = meta?.getBoundingClientRect();
    return { colRight: col.right, rowRight: r.right, claimW: c.width, claimRight: c.right, claimBottom: c.bottom, metaTop: m?.top ?? null, metaRight: m?.right ?? null };
  });
});

test('[SID:5051] the goal page\'s trust rail @288 — one line each, claim ≥ 200 px, nothing past the rail', async ({ page }) => {
  await open(page, 288, '__mountRail');
  const rows = await measureRail(page);
  expect(rows).toHaveLength(2);
  for (const r of rows) {
    expect(r.metaTop, 'the meta group (the avatar) is drawn — a missing one must not pass the geometry below').not.toBeNull();
    expect(r.rowRight, 'row inside the rail').toBeLessThanOrEqual(r.colRight + 0.5);
    expect(r.claimW, 'the claim keeps its floor in the rail').toBeGreaterThanOrEqual(200);
    expect(r.metaTop!, 'the avatar stays on the claim\'s line').toBeLessThan(r.claimBottom);
  }
});

test('[SID:5051] a rail narrower than the claim\'s 13rem floor: the floor yields to the rail (nothing past it) and the avatar drops to a second line', async ({ page }) => {
  await open(page, 200, '__mountRail');
  const rows = await measureRail(page);
  for (const r of rows) {
    expect(r.metaTop, 'the meta group (the avatar) is drawn').not.toBeNull();
    expect(r.rowRight, 'row inside the narrow rail').toBeLessThanOrEqual(r.colRight + 0.5);
    expect(r.claimRight, 'the claim is inside the row').toBeLessThanOrEqual(r.rowRight + 0.5);
    expect(r.claimW, 'the claim is still there').toBeGreaterThan(80);
    expect(r.claimW, 'the floor is a floor of the rail, not past it').toBeLessThan(200);
    expect(r.metaRight!, 'the avatar is inside the row').toBeLessThanOrEqual(r.rowRight + 0.5);
    expect(r.metaTop!, 'the avatar is on a second line').toBeGreaterThanOrEqual(r.claimBottom - 1);
  }
});
