/**
 * story #4326(까디르 4688 · PO) — 상단바 폴백 표(`FLAT_ROUTE_TOP_BAR`)의 «목적지 전수»를 **실제 라우트에서** 뽑아 대조한다.
 *
 * 왜 runs를 놓쳤나: 원래 전수 테스트(flat-tab-top-bar.test.tsx «표의 모든 경로가 자기 loading.tsx에서…»)는 **표 → loading** 한 방향이었다 —
 * 표에 없는 경로는 애초에 안 봤다. `/organization/workforce/runs`는 부모 `workforce/loading`이 덮는데 그 폴백은 마지막 조각이
 * `workforce`일 때만 쥐어(목록 전용) 실행 목록 로딩 동안 상단바가 빈 채였다.
 *
 * 규칙: `app/(authenticated)` 아래 page.tsx마다(= 실제 라우트) 하나로 분류돼야 한다 — 손으로 쓴 목록 없음.
 *   - 표: `FLAT_ROUTE_TOP_BAR` 키.
 *   - 상세: `[ws]/[proj]` 뒤에 동적 조각(`[id]` 등)이 있다 — 제목(뒤로 · 이름)이 다르고 칩이 없어 목록 폴백을 안 세운다(목록 전용 규칙).
 *   - 일감 탭: `[ws]/[proj]/<WORKSPACE_FRAME_TAB_PATHS>` — 4291 WorkTabsFrame이 쥔다.
 *   - 상단바 제목 없음: 도착 화면이 `<TopBarSlot`을 안 쓴다(본문 머리가 제목 · 4688 AC2 관찰) — **import를 따라가 확인**한다.
 *     닿으면 «상단바를 채우는 화면인데 표에 없음» → RED(runs가 이 모양).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { FLAT_ROUTE_TOP_BAR } from './flat-tab-top-bar';
import { WORKSPACE_FRAME_TAB_PATHS } from '@/components/workspace/workspace-frame-tabs';

const SRC = path.resolve(__dirname, '../..');
const APP = path.join(SRC, 'app/(authenticated)');
/** import를 따라가는 깊이 — 실 트리에서 2 · 3 · 4 · 6 모두 같은 결과(page → 화면 컴포넌트 → 그 조각이면 충분). 여유로 4. */
const DEPTH = 4;

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec);
  else return null;
  for (const c of [base, `${base}.tsx`, `${base}.ts`, path.join(base, 'index.tsx'), path.join(base, 'index.ts')]) {
    if (/\.tsx?$/.test(c) && existsSync(c)) return c;
  }
  return null;
}

/** 파일에서 import를 따라가 `<TopBarSlot`을 쓰는 파일을 찾는다(타입 전용 import 제외). 없으면 null. */
export function reachesTopBarSlot(file: string, depth = DEPTH, seen = new Set<string>()): string | null {
  if (seen.has(file)) return null;
  seen.add(file);
  const text = readFileSync(file, 'utf8');
  if (/<TopBarSlot\b/.test(text)) return file;
  if (depth === 0) return null;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || st.importClause?.isTypeOnly) continue;
    const next = resolveImport(file, st.moduleSpecifier.text);
    const hit = next && reachesTopBarSlot(next, depth - 1, seen);
    if (hit) return hit;
  }
  return null;
}

/** 라우트의 도착 화면 입구 — page.tsx와 **그 폴더 자신의** layout.tsx(문서처럼 제목을 layout이 채우는 경로). 조상 layout은 안 본다
 * (`[ws]/[proj]/layout`은 일감 탭 틀이라 넣으면 프로젝트 아래 전부가 닿은 것으로 보인다). */
function routeReachesTopBarSlot(route: string): string | null {
  const seen = new Set<string>();
  for (const entry of ['page.tsx', 'layout.tsx']) {
    const file = path.join(APP, route, entry);
    const hit = existsSync(file) && reachesTopBarSlot(file, DEPTH, seen);
    if (hit) return hit;
  }
  return null;
}

function realRoutes(dir = APP, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) realRoutes(full, out);
    else if (entry.name === 'page.tsx') out.push(path.relative(APP, dir).split(path.sep).join('/'));
  }
  return out.sort();
}

type Kind = 'table' | 'detail' | 'workTab' | 'noTopBarTitle';

function classify(route: string): { kind: Kind } | { kind: 'unclassified'; slotIn: string } {
  if (route in FLAT_ROUTE_TOP_BAR) return { kind: 'table' };
  const segments = route.split('/');
  const rest = route.startsWith('[ws]/[proj]/') ? segments.slice(2) : segments;
  if (rest.some((s) => s.startsWith('['))) return { kind: 'detail' };
  if (route.startsWith('[ws]/[proj]/') && rest.length === 1 && WORKSPACE_FRAME_TAB_PATHS.includes(rest[0])) return { kind: 'workTab' };
  const slotIn = routeReachesTopBarSlot(route);
  return slotIn ? { kind: 'unclassified', slotIn: path.relative(SRC, slotIn) } : { kind: 'noTopBarTitle' };
}

describe('상단바 폴백 표 — 실제 라우트 전수(story #4326 · 까디르 4688)', () => {
  it('따라가기 기준점 — 실행 목록은 TopBarSlot에 닿고(양성) · 멤버 화면은 안 닿는다(음성) · 문서는 자기 layout으로 닿는다', () => {
    expect(routeReachesTopBarSlot('organization/workforce/runs'), '양성 대조').not.toBeNull();
    expect(routeReachesTopBarSlot('organization/members'), '음성 대조').toBeNull();
    expect(routeReachesTopBarSlot('[ws]/[proj]/docs'), 'layout 입구').not.toBeNull();
  });

  it('⭐page.tsx마다 «표 · 상세 · 일감 탭 · 상단바 제목 없음(확인됨)» 중 하나 — 상단바를 채우는 화면이 표에 없으면 RED', () => {
    const routes = realRoutes();
    expect(routes.length, '라우트를 실제로 모았다').toBeGreaterThan(40);
    const unclassified = routes.flatMap((r) => {
      const c = classify(r);
      return c.kind === 'unclassified' ? [`${r} — ${c.slotIn}이 상단바를 채운다 → FLAT_ROUTE_TOP_BAR에 한 줄 + 자기 loading.tsx`] : [];
    });
    expect(unclassified).toEqual([]);
  });

  it('표의 경로는 실제 라우트다(없는 폴더 이름이 표에 남지 않게)', () => {
    const routes = new Set(realRoutes());
    expect(Object.keys(FLAT_ROUTE_TOP_BAR).filter((r) => !routes.has(r))).toEqual([]);
  });
});
