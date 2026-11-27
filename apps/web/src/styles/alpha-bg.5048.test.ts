// story 5048 ③b-2 — 배경 색에 «알파»(`bg-muted/40` · `bg-primary/10` · `bg-info/10` …)를 새로 쓰지 않는다. 키트: 면은 불투명 역할 색(면 차이로 층이 갈린다).
// 걷은 규칙(새 토큰 0 — ds 부품이 이미 쓰는 면 재사용):
//  · muted/secondary 깔림(N≤60) → 테두리 있는 칩 · 작은 조각 `bg-ds-background` · 테두리 없는 자리와 «테두리 있는 둥근 상자(rounded-md+ · 안여백 있음 · 카드 subtle 포함)» `bg-ds-surface-sunk`(흰 면 · 페이지 바탕 어디서든 갈림 — 페이지 바탕(ds-background)과 같으면 «배경 위 무표면 상자» 가드(e2e/card-surface-guard)가 잡는다) · N≥70 → `bg-muted`
//  · muted 호버 → `hover:bg-ds-surface-high`
//  · primary/brand 옅은 틴트(N≤20) → `bg-ds-action-soft` · 호버 N≥80 → `hover:bg-ds-ink-2` · 실색 N≥50 → `bg-ds-action`
//  · 상태색(info · success · warning · destructive) 틴트 N≤40 → `bg-{상태}-tint`(옛 가드가 알아보는 이름 그대로) · input → `bg-ds-surface-sunk` · 점 · 구분선 → `ds-line` · `ds-line-strong`
// 되돌리면 RED. 남은 자리(범주 밖 — 스크림 · 흰/검정 · 팔레트 색 · 실색에 가까운 상태색(N>40) · 반투명 유리(`bg-card/95 backdrop-blur`) · 베일 · 호버 베일)는 ③b-3 · ③d 래칫 몫이라 여기 세지 않는다.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');
// 민(C1)의 nav/* · 사이드바 파일은 이 단계에서 건드리지 않는다(경계) — 허용 목록이 아니라 경계 제외.
const OUT_OF_BOUNDARY = [/^components\/nav\//, /(^|\/)app-sidebar/, /(^|\/)nav-rail/, /(^|\/)nav-placement/];
// «알파가 맞는 자리» — 파일 · 클래스 단위, 사유 한 줄. 내용을 덮는 베일은 불투명이면 내용이 사라진다.
const KEPT = new Set(['components/docs/doc-editor.tsx::bg-info/10']); // 파일 끌어다 놓기 오버레이: 편집 내용 위에 깔리는 베일(pointer-events-none) — 불투명이면 글이 가려짐

const STATUS = ['info', 'info-tint', 'success', 'success-tint', 'warning', 'warning-tint', 'destructive', 'destructive-tint'];
const RX = /(?<![A-Za-z0-9_-])((?:[a-z0-9@\[\]()_.:&>*=%-]+:)*)bg-([a-z][a-z0-9-]*)\/(\d+|\[[0-9.]+\])(?![A-Za-z0-9_-])/g;

/** 이 알파 배경이 «걷어야 하는 범주»인가(걷는 스크립트와 같은 규칙). */
function covered(pre: string, color: string, n: number): boolean {
  if (Number.isNaN(n)) return ['muted', 'secondary', 'accent', 'input', 'primary', 'brand', ...STATUS].includes(color); // 임의 알파 `/[0.5]`는 값을 몰라 같은 색이면 전부 범주
  if (['muted', 'secondary', 'accent', 'input', 'border', 'muted-foreground'].includes(color)) return true;
  if (color === 'primary' || color === 'brand') return n <= 20 || n >= 50;
  if (STATUS.includes(color)) return n <= 40;
  return false;
}

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name === 'node_modules') continue; yield* sources(p); continue; }
    if (!/\.(tsx?|css)$/.test(name) || /\.(test|spec)\./.test(name)) continue;
    yield p;
  }
}

describe('배경에 알파를 쓰지 않는다 — 5048 ③b-2', () => {
  const offenders: string[] = [];
  for (const file of sources(SRC)) {
    const rel = relative(SRC, file);
    if (OUT_OF_BOUNDARY.some((r) => r.test(rel))) continue;
    for (const m of readFileSync(file, 'utf8').matchAll(RX)) {
      if (KEPT.has(`${rel}::bg-${m[2]}/${m[3]}`)) continue;
      if (covered(m[1] ?? '', m[2]!, m[3]!.startsWith('[') ? Number.NaN : Number(m[3]))) offenders.push(`${rel}: ${m[0]}`);
    }
  }
  it('⭐범주 안(깔림 · 호버 · 틴트 · 입력면 · 점) 알파 배경 0 — `bg-muted/40` → `bg-ds-background` · `bg-primary/10` → `bg-ds-action-soft`', () => {
    expect(offenders).toEqual([]);
  });
});
