// UI-3(a9d56577) · 4906 — «화면 층 규칙» 회귀가드: 층 토큰의 실제 값(design-system.css · 라이트 · 다크)으로 이웃한 두 층의 밝기차(OKLab L)를 계산해 최소 크기를 지킨다.
// 토큰 값을 바꾸거나 층에 다른 토큰을 쓰면 여기가 빨개진다 — 숫자는 components/ds/layers.ts 머리표와 같다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LAYER, LAYER_MIN_STEP, LAYER_TOKEN } from '../components/ds/layers';
import { cn } from '../lib/utils';
import { ASSET_ROW_FACE } from '../components/storage/storage-asset-row';
import { ASSET_CARD_FACE, ASSET_CARD_WELL } from '../components/storage/storage-asset-grid';
import { ARTIFACT_CARD_FACE, ARTIFACT_CARD_WELL, ARTIFACT_PANEL } from '../components/canvas/artifact-gallery-view';
import { HYPOTHESES_FACE, HYPOTHESIS_BAND_FACE } from '../components/hypotheses/hypotheses-face';
import { GOALS_FRAME_FACE } from '../app/(authenticated)/[ws]/[proj]/goals/goals-layer';
import { AGENT_RUNS_PANEL_FACE, AGENT_RUNS_ROW_FACE } from '../components/agents/agent-runs-list';
import { VARIANT_REASON_FACE, VARIANT_TILE_FACE, VARIANT_TILE_WELL } from '../components/loops/variant-gallery';
import { LOOP_PANEL_FACE, LOOP_ROW_FACE, LOOP_ROW_HOVER } from '../app/(authenticated)/[ws]/[proj]/loops/loops-layer';

const css = readFileSync(join(__dirname, 'design-system.css'), 'utf8');

function block(selector: string): Record<string, string> {
  const m = css.match(new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')}(?:,\\s*\\.[\\w-]+)*\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`block ${selector} not found`);
  return Object.fromEntries([...m[1].matchAll(/--ds-([\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)].map((x) => [x[1], x[2].toLowerCase()]));
}
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
/** OKLab 밝기 L (0~1) — 사람 눈이 느끼는 밝기에 가깝게 고른 척도 */
function lightness(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255)) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
}

/** OKLab 채도 C — a, b 성분의 크기 */
function chroma(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255)) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return Math.hypot(1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s);
}

/** WCAG 대비 배율 */
function contrast(a: string, b: string): number {
  const relative = (hex: string) => {
    const [r, g, b2] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255)) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b2;
  };
  const [hi, lo] = [relative(a), relative(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const themes: Array<[string, Record<string, string>]> = [['라이트', block(':root')], ['다크', block('.dark')]];
const step = (t: Record<string, string>, from: keyof typeof LAYER_TOKEN, to: keyof typeof LAYER_TOKEN) => Math.abs(lightness(t[LAYER_TOKEN[to]]!) - lightness(t[LAYER_TOKEN[from]]!));

// 4909 AC3 (가설 칸 1단계) — the goal screen is ONE reading area on the PAGE layer; its cards (the hypotheses card included) are the content layer one step above. The old hypotheses card (`bg-muted/20`) measured −.018 / −.004
// against the page on dev (it did not separate); this pins the two faces to the layer map and the step between them to the line (≥ .03, both themes).
describe('목표 화면(4909) — 틀 = 바탕, 카드 = 내용 칸', () => {
  it('틀 · 상세 열은 바탕 층이고 가설 카드 면은 내용 칸 층이다(토큰 이름)', () => {
    expect(GOALS_FRAME_FACE).toBe(LAYER.page);
    expect(HYPOTHESES_FACE).toBe(LAYER.panel);
    expect(GOALS_FRAME_FACE).not.toBe(HYPOTHESES_FACE);
  });
  it.each(themes)('⭐%s: 가설 카드 → 결재 띠 면(글 줄 층) ≥ 0.05 · 카드 → 양식 입력칸(입력칸 층) ≥ 0.05', (_name, t) => {
    expect(HYPOTHESIS_BAND_FACE).toBe(LAYER.rowOthers);
    expect(step(t, 'panel', 'rowOthers')).toBeGreaterThanOrEqual(LAYER_MIN_STEP.rowOthersOnPanel);
    expect(step(t, 'panel', 'field')).toBeGreaterThanOrEqual(LAYER_MIN_STEP.fieldOnPanel);
  });
  it.each(themes)('⭐%s: 바탕 → 가설 카드 면 ≥ 0.03 (라이트 +.030 · 다크 +.036 — 옛 카드는 −.018 / −.004라 갈리지 않았다)', (_name, t) => {
    expect(step(t, 'page', 'panel')).toBeGreaterThanOrEqual(LAYER_MIN_STEP.panelOverPage);
  });
});

describe('화면 층 규칙 — 이웃한 층은 눈으로 갈린다', () => {
  it.each(themes)('⭐%s: 바탕 → 내용 칸 ≥ 0.03 · 내용 칸 → 남의 글 ≥ 0.05 · 내 글 ≥ 0.09 · 입력칸 ≥ 0.05', (_name, t) => {
    expect(step(t, 'page', 'panel')).toBeGreaterThanOrEqual(LAYER_MIN_STEP.panelOverPage);
    expect(step(t, 'panel', 'rowOthers')).toBeGreaterThanOrEqual(LAYER_MIN_STEP.rowOthersOnPanel);
    expect(step(t, 'panel', 'rowMine')).toBeGreaterThanOrEqual(LAYER_MIN_STEP.rowMineOnPanel);
    expect(step(t, 'panel', 'field')).toBeGreaterThanOrEqual(LAYER_MIN_STEP.fieldOnPanel);
  });

  it.each(themes)('⭐%s: 카드 상세(4908) — 서랍(panel) → 속성 칸(rowOthers) 밝기차 ≥ 0.05, 그 칸 안 흐린 글(ink-3)은 4.5:1 이상', (_name, t) => {
    expect(step(t, 'panel', 'rowOthers'), '서랍 → 속성 칸').toBeGreaterThanOrEqual(LAYER_MIN_STEP.rowOthersOnPanel);
    expect(contrast(t['ink-3']!, t[LAYER_TOKEN.rowOthers]!), '속성 칸 안 ink-3').toBeGreaterThanOrEqual(4.5);
  });

  it.each(themes)('⭐%s: 카드 상세 속성 칸(rowOthers) 안의 입력칸 · 후보 칩은 내용 칸 면(panel)을 쓴다 — 속성 칸 → panel ≥ 0.05', (_name, t) => {
    expect(step(t, 'rowOthers', 'panel'), '속성 칸 → 입력칸 면').toBeGreaterThanOrEqual(LAYER_MIN_STEP.rowOthersOnPanel);
  });

  it('⭐옛 문제 재현 가드(4908): 속성 칸 위에 LAYER.field(sunk)를 얹으면 라이트에서 면이 안 갈린다(0.012) — 그래서 입력칸 면은 panel이다', () => {
    expect(step(themes[0]![1], 'rowOthers', 'field')).toBeLessThan(LAYER_MIN_STEP.rowOthersOnPanel);
  });

  it.each(themes)('⭐%s: 열린 카드(4908) — 내용 칸과 ΔL ≥ 0.03, 같은 줄 층 글 줄과 채도차 ≥ 0.01(밝기는 거의 같아 왼쪽 막대와 함께 가른다)', (_name, t) => {
    expect(step(t, 'panel', 'rowSelected')).toBeGreaterThanOrEqual(LAYER_MIN_STEP.rowSelectedOnPanel);
    expect(chroma(t[LAYER_TOKEN.rowSelected]!) - chroma(t[LAYER_TOKEN.rowOthers]!)).toBeGreaterThanOrEqual(LAYER_MIN_STEP.rowSelectedVsOthersChroma);
  });

  it('⭐옛 문제 재현 가드: «바탕 ↔ 떠 있는 면»처럼 면 차이로 가르지 않는 쌍(0.009)이 층 표에 이웃으로 들어오지 않는다', () => {
    // 라이트에서 바탕과 떠 있는 면의 밝기차는 0.009(선생님 지적의 뿌리) — 그래서 떠 있는 것은 면이 아니라 그림자 + 경계로 가른다고 표에 적었다.
    expect(step(themes[0]![1], 'page', 'floating')).toBeLessThan(LAYER_MIN_STEP.panelOverPage);
  });

  it.each(themes)('⭐%s: 글 줄 면 위의 글자(ink · ink-2 · action-text)는 4.5:1 이상 — 새 면 위에서 옛 muted/primary 글자가 못 읽히던 사고 방지', (_name, t) => {
    for (const row of ['rowOthers', 'rowMine', 'rowSelected'] as const) {
      for (const ink of ['ink', 'ink-2', 'action-text']) expect(contrast(t[ink]!, t[LAYER_TOKEN[row]]!), `${ink} on ${row}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(themes)('⭐%s: 보드 카드 안 글자 — 평소 카드는 ink-3(흐린 글)까지, 열린 카드는 ink-2까지 4.5:1 이상(다크에서 ink-3은 열린 카드 면 위 4.29:1이라 모자란다 — codex 4908)', (_name, t) => {
    expect(contrast(t['ink-3']!, t[LAYER_TOKEN.rowOthers]!), 'ink-3 on rowOthers').toBeGreaterThanOrEqual(4.5);
    for (const ink of ['ink', 'ink-2']) expect(contrast(t[ink]!, t[LAYER_TOKEN.rowSelected]!), `${ink} on rowSelected`).toBeGreaterThanOrEqual(4.5);
  });

  it.each(themes)('⭐%s: 고르는 동그라미 · 칸 경계(line-control)는 속성 칸 · 내용 칸 면 위에서 비글자 3:1 이상 — 옛 border-input은 바탕과 거의 같은 색이라 «고를 수 있는지» 안 보였다(11-13 PO)', (_name, t) => {
    for (const face of ['rowOthers', 'panel'] as const) expect(contrast(t['line-control']!, t[LAYER_TOKEN[face]]!), `line-control on ${face}`).toBeGreaterThanOrEqual(3);
    expect(contrast(t['line-control']!, t['surface-sunk']!), 'line-control on the radio fill (surface-sunk)').toBeGreaterThanOrEqual(3);
  });

  it('층마다 토큰이 서로 다르다(같은 토큰을 두 층에 쓰지 않는다) · 클래스 이름이 토큰 이름을 가리킨다', () => {
    const tokens = Object.values(LAYER_TOKEN);
    expect(new Set(tokens).size).toBe(tokens.length);
    for (const key of Object.keys(LAYER) as Array<keyof typeof LAYER>) expect(LAYER[key]).toBe(`bg-ds-${LAYER_TOKEN[key]}`);
  });

  it.each(themes)('⭐%s: 내 글 ↔ 남의 글은 색조만이 아니라 밝기(ΔL ≥ 0.05)와 채도(ΔC ≥ 0.03) 둘 다 갈린다(연보라 ↔ 연회색 사고 11-12)', (_name, t) => {
    const mine = t[LAYER_TOKEN.rowMine]!;
    const others = t[LAYER_TOKEN.rowOthers]!;
    expect(Math.abs(lightness(mine) - lightness(others))).toBeGreaterThanOrEqual(LAYER_MIN_STEP.mineVsOthersLightness);
    expect(chroma(mine) - chroma(others)).toBeGreaterThanOrEqual(LAYER_MIN_STEP.mineVsOthersChroma);
  });

  // 4913(UI-R5) 한 쪽 틀 — 틀 부품이 이 층 표를 «그대로» 쓴다: 쪽 바탕 = page(셸이 한 번 칠한다 — 틀은 안 칠함), 패널(Card) = panel, 행 안 펼침 = rowOthers, 입력칸 = field. 부품이 다른 면을 쓰면 아래가 빨개진다.
  it.each(themes)('⭐%s: 한 쪽 틀 — 패널(RowList=Card)이 쪽 바탕(ds-background)보다 한 층 올라온다(≥ 0.03) · 열린 행 면이 패널과 갈린다(≥ 0.05)', (_name, t) => {
    expect(step(t, 'page', 'panel')).toBeGreaterThanOrEqual(LAYER_MIN_STEP.panelOverPage);
    expect(step(t, 'panel', 'rowOthers')).toBeGreaterThanOrEqual(LAYER_MIN_STEP.rowOthersOnPanel);
  });

  it('⭐한 쪽 틀 부품의 면 클래스가 층 표와 같다: PageFrame은 바탕을 안 칠함(셸 몫) · Card(RowList)=panel · 열린 행=rowOthers', () => {
    const dir = join(__dirname, '..', 'components', 'ds');
    const src = (f: string) => readFileSync(join(dir, f), 'utf8');
    expect(src('page-frame.tsx')).not.toMatch(/LAYER\.page|bg-ds-/);
    expect(src('row-list.tsx')).toContain('LAYER.rowOthers');
    expect(src('row-list.tsx')).toMatch(/<Card\b/);
    expect(src('card.tsx')).toContain(LAYER.panel);
  });

  // 4910 — 스토리지 화면의 층(행 · 카드 · 썸네일 우물). 화면 코드가 층 표의 이름을 «그대로» 쓰는지(층 표를 두고 따로 색을 고르지 않는지)와 그 층 사이가 눈으로 갈리는지를 함께 지킨다.
  it('⭐스토리지: 행 얼굴 · 카드 얼굴 = 남의 글 줄과 같은 층(rowOthers), 썸네일 우물 = well — 화면이 층 표 이름을 그대로 쓴다', () => {
    expect(ASSET_ROW_FACE).toBe(LAYER.rowOthers);
    expect(ASSET_CARD_FACE).toBe(LAYER.rowOthers);
    expect(ASSET_CARD_WELL).toBe(LAYER.well);
  });

  it.each(themes)('⭐%s: 스토리지 — 내용 칸 → 행/카드 면 ≥ 0.05 · 카드 면 → 썸네일 우물 ≥ 0.03 · 호버(내용 칸 색)와 행 면도 같은 0.05로 갈린다', (_name, t) => {
    expect(step(t, 'panel', 'rowOthers')).toBeGreaterThanOrEqual(LAYER_MIN_STEP.rowOthersOnPanel); // 행 얼굴 ↔ 내용 칸(= 호버 색)
    expect(step(t, 'rowOthers', 'well')).toBeGreaterThanOrEqual(LAYER_MIN_STEP.wellOnRow);
  });

  // 4910 — 산출물 갤러리의 층: 카드 얼굴 = rowOthers · 썸네일 우물 = well · 바탕 칸 = panel. 스토리지와 같은 세 층이라 같은 간격 시험(위)이 이 화면도 덮는다.
  it('⭐산출물 갤러리: 카드 얼굴 = rowOthers · 썸네일 우물 = well · 칸 = panel — 화면이 층 표 이름을 그대로 쓴다', () => {
    expect(ARTIFACT_CARD_FACE).toBe(LAYER.rowOthers);
    expect(ARTIFACT_CARD_WELL).toBe(LAYER.well);
    expect(ARTIFACT_PANEL).toBe(LAYER.panel);
  });

  // 4913(셸 바탕 PR · PO 11-12) — «쪽 바탕은 한 토큰(ds-background = LAYER.page)»: 앱 틀(셸)이 한 번 칠한다. 셸 · 막대가 옛 bg-background를 칠하면 새 패널과의 층이 라이트 0.027로 선 아래가 되고, 틀(PageFrame)은 안 칠하니 색이 어긋난다.
  it('⭐셸 바탕 → 패널: 셸 본문(SidebarInset)과 상단 막대가 쪽 바탕 층 토큰(LAYER.page)을 쓰고 옛 bg-background를 안 쓴다', () => {
    const src = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    const shell = src('app/dashboard/dashboard-shell.tsx');
    expect(shell).toMatch(/<SidebarInset className=\{cn\([^)]*LAYER\.page\)\}>/);
    expect(shell).not.toMatch(/<SidebarInset[^>]*bg-background/);
    const bar = src('components/nav/top-bar.tsx');
    expect(bar).toContain('LAYER.page');
    expect(bar).not.toMatch(/['" ]bg-background['" ]/);
  });

  it('⭐클래스 병합: SidebarInset의 옛 bg-background 위에 LAYER.page를 얹으면 새 바탕만 남는다(tailwind-merge가 같은 묶음으로 본다)', () => {
    expect(cn('relative bg-background', LAYER.page)).toBe('relative bg-ds-background');
  });

  it.each(themes)('⭐%s: 셸 바탕(ds-background) → 패널(ds-surface) ≥ 0.03 · 셸이 칠하는 면 = 층 표의 page 토큰', (_name, t) => {
    expect(LAYER_TOKEN.page).toBe('background');
    expect(step(t, 'page', 'panel')).toBeGreaterThanOrEqual(LAYER_MIN_STEP.panelOverPage);
  });

  // 4913(셸 바탕 PR · codex 검수) — 셸 안에서 «쪽 바탕 자리»를 옛 bg-background로 칠하던 곳(붙는 띠 · 전폭 면 · 채팅 · 문서 바탕 · 오류 화면)은 같은 토큰(LAYER.page = bg-ds-background)이다. 하나라도 옛 색으로 되돌아가면
  // 셸(차가운 ds 바탕) 위에 따뜻한 옛 바탕 띠가 떠 보인다. 아래 문자열은 그 자리의 클래스 한 줄 그대로다(셸 밖 화면 — 로그인 · 온보딩 · 초대 · 폰 첫 화면 · v3 /today · /chat(`app/(v3)`, DashboardShell 밖) — 은 몸통 바탕(옛 토큰) 위라 대상이 아니다: 거기 서 있는 칸을 ds 색으로 바꾸면 오히려 따뜻한 바탕 위에 차가운 칸이 뜬다).
  const PAGE_FILLS: Array<[string, string]> = [
  ['app/(authenticated)/[ws]/[proj]/loops/loops-layer.ts', "sticky top-0 z-10 -mx-4 bg-ds-background px-4 py-2 sm:-mx-6 sm:px-6"],
  ['app/(authenticated)/[ws]/[proj]/standup/standup-client.tsx', "sticky top-0 z-10 space-y-1 border-b border-border/80 bg-ds-background px-6 py-3"],
  ['app/(authenticated)/[ws]/[proj]/standup/standup-client.tsx', "sticky top-0 z-10 flex flex-wrap items-center gap-1.5 border-b border-border/80 bg-ds-background px-4 py-2 lg:hidden"],
  ['app/(authenticated)/channel/page.tsx', "flex flex-col bg-ds-background"],
  ['app/(authenticated)/channel/page.tsx', "sticky bottom-0 border-t border-border bg-ds-background px-4 pb-safe-4 pb-4 pt-3"],
  ['app/(authenticated)/chats/[conversation_id]/page.tsx', "flex min-h-0 flex-1 flex-col overflow-hidden bg-ds-background"],
  ['app/(authenticated)/chats/layout.tsx', "fixed inset-y-0 left-0 z-40 w-[270px] bg-ds-background shadow-[var(--elev-overlay)] border-r border-border lg:!flex lg:!w-[270px] xl:static xl:z-auto xl:w-[270px] xl:shadow-none"],
  ['components/chat/chat-input.tsx', "relative flex-shrink-0 border-t border-ds-line bg-ds-background px-2 py-3 sm:px-3"],
  ['components/chat/embed-card.tsx', "flex h-full flex-col overflow-hidden bg-ds-background"],
  ['components/chat/reading-panel.tsx', "flex h-full flex-col overflow-hidden border-l border-border bg-ds-background"],
  ['components/org-briefing/org-briefing-shell.tsx', "sticky bottom-0 -mx-4 bg-ds-background px-4 pb-4 lg:-mx-6 lg:px-6"],
  ['components/ui/route-error-state.tsx', "min-h-screen bg-ds-background"],
  ['components/workspace/work-tabs-frame.tsx', "sticky top-0 z-10 bg-ds-background px-4 pt-3"],
  ['components/docs/doc-editor.tsx', 'border-t border-border/60 bg-ds-background/95 pb-[env(safe-area-inset-bottom)]'],
  ];
  it.each(PAGE_FILLS)('⭐쪽 바탕 자리 = 층 토큰: %s 에 «%s»', (file, snippet) => {
    expect(readFileSync(join(__dirname, '..', file), 'utf8')).toContain(snippet);
    expect(snippet).toContain('bg-ds-background');
    expect(snippet).not.toMatch(/(?<![\w-])bg-background(?![\w-])/);
  });

  it('⭐옛 스켈레톤 하이라이트는 새 쪽 바탕과 섞인다(옛 --background 아님)', () => {
    const globals = readFileSync(join(__dirname, '..', 'app', 'globals.css'), 'utf8');
    expect(globals).toMatch(/--skeleton-highlight:[^;]*var\(--ds-background\)/);
    expect(globals).not.toMatch(/--skeleton-highlight:[^;]*var\(--background\)/);
  });

  // 4910 — 산출물 상세: 보기 영역(well)이 내용 칸(panel) 바로 위에 선다(목록 카드와 달리 사이에 행 면이 없다) — 그 간격도 눈으로 갈린다.
  it.each(themes)('⭐%s: 산출물 상세 — 내용 칸 → 보기 영역(well) ≥ 0.03', (_name, t) => {
    expect(step(t, 'panel', 'well')).toBeGreaterThanOrEqual(LAYER_MIN_STEP.wellOnRow);
  });
});

// 4916 — 대화 방은 내용 칸 판을 따로 깔지 않고 «쪽 바탕(page)» 위에 말풍선 · 입력칸만 선다(선생님 11-13 «채팅창 안에만 흰색 — 역겨움»). 그래서 말풍선 · 입력칸 값이 «바탕 기준»으로도 선을 지켜야 한다.
// 라이트의 바탕(#f3f5f9, L .970)은 내용 칸(흰색)보다 어두워, 옛 남의 글 면(.948)은 바탕과 .022밖에 안 갈렸다 → 토큰 값에서 고친다(채팅만 덧칠 X — 같은 «바탕 위 면이 흐림»이 다른 화면에도 있다).
describe('화면 층 규칙 — 바탕(page) 위 말풍선 · 입력칸 (4916)', () => {
  it.each(themes)('⭐%s: 바탕 → 남의 글 ≥ 0.05 · 내 글 ≥ 0.09 · 입력칸 ≥ 0.03(경계가 함께 가른다) — 방 안에 따로 까는 판이 없어도 말풍선이 보인다', (_name, t) => {
    expect(step(t, 'page', 'rowOthers')).toBeGreaterThanOrEqual(LAYER_MIN_STEP.rowOthersOnPage);
    expect(step(t, 'page', 'rowMine')).toBeGreaterThanOrEqual(LAYER_MIN_STEP.rowMineOnPage);
    expect(step(t, 'page', 'field')).toBeGreaterThanOrEqual(LAYER_MIN_STEP.fieldOnPage);
  });

  it.each(themes)('⭐%s: 값을 옮긴 뒤에도 옛 선은 그대로 — 내용 칸 → 입력칸 ≥ 0.05 · 카드 면 → 우물 ≥ 0.03 · 열린 카드 ↔ 글 줄 채도차 ≥ 0.01', (_name, t) => {
    expect(step(t, 'panel', 'field')).toBeGreaterThanOrEqual(LAYER_MIN_STEP.fieldOnPanel);
    expect(step(t, 'rowOthers', 'well')).toBeGreaterThanOrEqual(LAYER_MIN_STEP.wellOnRow);
    expect(chroma(t[LAYER_TOKEN.rowSelected]!) - chroma(t[LAYER_TOKEN.rowOthers]!)).toBeGreaterThanOrEqual(LAYER_MIN_STEP.rowSelectedVsOthersChroma);
  });

  it('⭐옛 값(라이트 남의 글 #eaeef4)은 바탕 위에서 문턱 아래였다 — 이 시험이 그 값에선 빨개진다(재현 가드)', () => {
    const t = { ...themes[0]![1], [LAYER_TOKEN.rowOthers]: '#eaeef4' };
    expect(step(t, 'page', 'rowOthers')).toBeLessThan(LAYER_MIN_STEP.rowOthersOnPage);
  });
});


// 4911 (UI-R3) — «실행 기록» 목록: 그룹(먼저 볼 것 · 진행 중 · 끝난 것)은 바탕 위 내용 칸, 한 행은 그 칸 위의 글 줄 면. 옛 화면은 행마다 카드+테두리를 같은 면에 깔아 면이 갈리지 않았다.
describe('실행 기록 목록(4911) — 바탕 → 그룹 칸 → 행', () => {
  it('그룹 칸은 내용 칸 층 · 행은 글 줄 층이다(토큰 이름)', () => {
    expect(AGENT_RUNS_PANEL_FACE).toBe(LAYER.panel);
    expect(AGENT_RUNS_ROW_FACE).toBe(LAYER.rowOthers);
    expect(AGENT_RUNS_PANEL_FACE).not.toBe(AGENT_RUNS_ROW_FACE);
  });
  it.each(themes)('⭐%s: 바탕 → 그룹 칸 ≥ 문턱 · 그룹 칸 → 행 ≥ 문턱', (_name, t) => {
    expect(step(t, 'page', 'panel')).toBeGreaterThanOrEqual(LAYER_MIN_STEP.panelOverPage);
    expect(step(t, 'panel', 'rowOthers')).toBeGreaterThanOrEqual(LAYER_MIN_STEP.rowOthersOnPanel);
  });
});

// 4911 AC3 — 실행(루프) 목록: 구획 패널(RowList = Card) = 내용 칸 · 행 얼굴 = 남의 글 줄 층. 옛 목록은 행(`bg-card`)과 바탕이 라이트 +0.027로 선 아래였다(dev 실측 11-12) — 이제 화면이 층 표 이름을 그대로 쓰고 그 사이가 선을 지킨다.
describe('실행 목록(4911) — 바탕 → 패널 → 행', () => {
  it('화면이 층 표 이름을 그대로 쓴다: 패널 = panel · 행 얼굴 = rowOthers', () => {
    expect(LOOP_PANEL_FACE).toBe(LAYER.panel);
    expect(LOOP_ROW_FACE).toBe(LAYER.rowOthers);
    expect(LOOP_ROW_HOVER).toContain(`hover:${LAYER.well}`);
    expect(LOOP_ROW_HOVER).toContain('hover:[&_div.font-mono]:text-ds-ink-2');
  });

  it.each(themes)('⭐%s: 호버 면(well) 위 — 둘째 줄 ink-2는 4.5:1 이상이고, 옛 ink-3은 아래라서 호버 동안 ink-2로 올린다', (_name, t) => {
    expect(contrast(t['ink-2']!, t[LAYER_TOKEN.well]!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t['ink-3']!, t[LAYER_TOKEN.well]!)).toBeLessThan(4.5);
  });

  it.each(themes)('⭐%s: 바탕 → 패널 ≥ 0.03 · 패널 → 행 얼굴 ≥ 0.05 (옛 «행 ↔ 내용 칸» 라이트 +0.027 · 다크 +0.059가 아니라)', (_name, t) => {
    expect(step(t, 'page', 'panel')).toBeGreaterThanOrEqual(LAYER_MIN_STEP.panelOverPage);
    expect(step(t, 'panel', 'rowOthers')).toBeGreaterThanOrEqual(LAYER_MIN_STEP.rowOthersOnPanel);
  });

  it('⭐호버 = 한 단 위(rowOthers → well)로 갈린다: 행 얼굴과 호버 면의 밝기차가 우물 선(≥ 0.03)을 지킨다', () => {
    for (const [, t] of themes) expect(step(t, 'rowOthers', 'well')).toBeGreaterThanOrEqual(LAYER_MIN_STEP.wellOnRow);
  });
});

// 4911 AC3 — 루프 상세: 틀 = 바탕 · 카드(목표 · 슬롯 · 과거 학습 · 속성 칸) = 내용 칸 · 후보 타일 = 글 줄 층 · 썸네일 = 우물 · 이유 칸 = 내용 칸.
describe('루프 상세(4911) — 바탕 → 카드 → 후보 타일 → 우물', () => {
  it('후보 갤러리가 층 표 이름을 그대로 쓴다: 타일 면 = rowOthers · 썸네일 = well · 이유 칸 = panel', () => {
    expect(VARIANT_TILE_FACE).toBe(LAYER.rowOthers);
    expect(VARIANT_TILE_WELL).toBe(LAYER.well);
    expect(VARIANT_REASON_FACE).toBe(LAYER.panel);
  });

  it.each(themes)('⭐%s: 바탕 → 카드 ≥ 0.03 · 카드 → 타일 ≥ 0.05 · 타일 → 썸네일 우물 ≥ 0.03 · 타일 → 이유 칸(panel)이 갈린다(≥ 0.05)', (_name, t) => {
    expect(step(t, 'page', 'panel')).toBeGreaterThanOrEqual(LAYER_MIN_STEP.panelOverPage);
    expect(step(t, 'panel', 'rowOthers')).toBeGreaterThanOrEqual(LAYER_MIN_STEP.rowOthersOnPanel);
    expect(step(t, 'rowOthers', 'well')).toBeGreaterThanOrEqual(LAYER_MIN_STEP.wellOnRow);
    expect(step(t, 'rowOthers', 'panel')).toBeGreaterThanOrEqual(LAYER_MIN_STEP.rowOthersOnPanel);
  });

  it.each(themes)('⭐%s: 썸네일 우물(well) 위 안내 글은 ink-2(≥ 4.5:1)다 — ink-3은 그 면 위에서 4.5 아래라 미리보기 자리에 쓰지 않는다', (_name, tk) => {
    expect(contrast(tk['ink-2']!, tk[LAYER_TOKEN.well]!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tk['ink-3']!, tk[LAYER_TOKEN.well]!)).toBeLessThan(4.5);
  });

  it('⭐옛 문제 재현 가드: 타일 면(rowOthers) 위에 입력칸 면(sunk)을 얹으면 라이트에서 면이 안 갈린다 — 그래서 이유 칸은 panel이다', () => {
    expect(step(themes[0]![1], 'rowOthers', 'field')).toBeLessThan(LAYER_MIN_STEP.fieldOnPanel);
  });
});
