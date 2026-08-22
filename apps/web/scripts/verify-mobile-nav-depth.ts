/**
 * story #2684(모바일 IA S4, 4단계 중 마지막) 회귀가드 — doc mobile-ia-full-completion-2678의
 * 판별자("주요 관리 화면 도달이 몇 탭인가")를 CI가 기계로 재는 자리. S1~S3가 4탭→2탭으로
 * 좁힌 게 다시 조용히 벌어지는 걸(IA가 다시 깊어지는 회귀) 사람 손 재감사 없이 잡는다
 * ("폐기 신호는 수렴을 잴 수 있어야" — doc §0 취지의 CI판).
 *
 * ── depth 모델(doc §2.2/§2.4) ──────────────────────────────────────────────
 *   depth 1     — MOBILE_HUB_EXCLUDE_IDS(바텀 탭 직행: flow·inbox·chats). 탭 1회.
 *   depth 2     — 그 외 항목 중 그룹이 MOBILE_HUB_GROUP_ORDER에 있다. 「전체」 탭 1회 +
 *                 허브 안 항목 선택 1회. 전제: /more 허브가 아코디언 없는 단일 평면
 *                 목록이라는 것(그 전제 자체는 이 가드가 아니라 more/page.test.tsx의 실
 *                 렌더 테스트가 지킨다, story #2682 AC3 — [aria-expanded] 요소 0건 확認).
 *   Infinity(도달불가) — 그룹이 MOBILE_HUB_GROUP_ORDER에서 빠졌다. more/page.tsx는
 *                 `MOBILE_HUB_GROUP_ORDER.map((id) => NAV_GROUPS.find(...))`로 순회하므로
 *                 그룹 id가 그 목록에서 빠지면 그 그룹 전체가 허브에서 조용히 사라진다 —
 *                 «더 깊어짐»이 아니라 «도달 불가»이지만, 둘 다 판별자(몇 탭에 도달하는가)
 *                 위반이라는 점은 같다(도달 불가 = depth ∞). 이 축이 실은 이 가드가 잡는
 *                 가장 현실적인 회귀다 — nav-config.ts에 새 관리면을 추가하면서
 *                 MOBILE_HUB_GROUP_ORDER 갱신을 깜빡하는 실수가, 항목 하나를 실제로 3탭짜리
 *                 서브메뉴에 옮겨 넣는 실수보다 훨씬 일어나기 쉽다.
 *
 * ── AC2 — 이 가드가 «못 잡는 것» (선언 없이 초록이면 「전부 봤다」로 읽힌다) ──────────
 *   ㉠런타임/조건부 depth — role·plan에 따라 메뉴 항목이 숨겨지거나 다른 경로로 재배치되는
 *     경우(feature flag 등). nav-config.ts는 정적 카탈로그라 그런 분기를 표현 못 한다.
 *   ㉡실 렌더 아코디언 회귀 — more/page.tsx가 언젠가 그룹을 <details>/Accordion으로 감싸
 *     depth+1을 만들어도 이 가드(순수 데이터 스캔)는 못 본다. more/page.test.tsx의 별도
 *     [aria-expanded] 부재 테스트가 그 축을 담당한다(가드 두 개가 서로 다른 축을 나눠 짐).
 *   ㉢/more 자신의 depth — 「전체」 탭이 바텀 탭바에서 정확히 1탭 거리라는 전제 자체는 이
 *     가드가 검증 안 한다(MobileTabBar 구조 변경은 별도 관심사).
 *   ㉣페이지 내부 서브내비게이션 — [ws]/[proj]/<resource> 도달 «이후» 그 화면 안에서 또
 *     몇 번 눌러야 하는지(예: workforce 하위 상세)는 이 가드의 스코프 밖(도달 depth=최상위
 *     목적지까지만, doc §2.4 표와 동일 범위).
 *   ㉤그룹 내부 항목 순서 — 이 가드는 항목이 그 그룹 안에 «있다/없다»만 본다. 항목이 그룹
 *     안에서 몇 번째로 뜨는지(스크롤 위치)는 depth 개념이 아니라서 다루지 않는다.
 *   ㉥챗 center(story #2930 P0-G I2, 데스크톱만 — 유나 확定 ⓒ, 2026-08-22) — 챗은 이제
 *     NAV_GROUPS 자체에 없다(데스크톱 4구역 밖 1급 승격, ㉢과 동형 이유로 사이드바 챗
 *     center 카드는 이 순수 데이터 스캔의 시야 밖). **모바일은 그대로다** — center FAB는
 *     4탭(오늘/워크/신뢰/지식) 최종 상태와 기하학적으로 한 세트라 「결재→오늘/AQ」 흡수
 *     (B3 확定) 전엔 도입 보류(카디르 QA HIGH·PR#3354 겹침 발견) — mobile-tab-bar.tsx는
 *     develop 5탭 그대로고 챗도 일반 탭 하나라 이 가드의 depth 계산 대상 밖(원래도 그랬다,
 *     이 파일이 스캔하는 건 NAV_GROUPS뿐이지 mobile-tab-bar.tsx의 독자 TABS가 아니다).
 *     데스크톱 챗 center의 depth-1 대응(구조적으로 보장, app-sidebar.tsx가 NAV_GROUPS
 *     순회 밖에 하드 배선)은 이 가드가 자동 검증 못 한다 — 렌더 검증은 app-sidebar.test.tsx
 *     가 맡는다(그룹 순서·라벨 회귀가드).
 */
import { MOBILE_HUB_EXCLUDE_IDS, MOBILE_HUB_GROUP_ORDER, NAV_GROUPS } from '../src/lib/nav-config';

export const MAX_MOBILE_DEPTH = 2;

export interface DepthEntry {
  id: string;
  groupId: string;
  depth: number;
}

// 이 함수가 실제로 쓰는 것만 구조로 요구한다(전체 NavGroupConfig가 아니라) — 테스트가
// 최소 픽스처(id·items[].id)만으로 독립 검증할 수 있게(AC1 양성대조가 실 nav-config.ts
// 타입에 묶이지 않는다).
export interface MinimalGroup {
  id: string;
  items: { id: string }[];
}

export function computeMobileDepths(
  groups: MinimalGroup[],
  excludeIds: Set<string>,
  hubGroupIds: Set<string>,
): DepthEntry[] {
  const entries: DepthEntry[] = [];
  for (const group of groups) {
    const inHub = hubGroupIds.has(group.id);
    for (const item of group.items) {
      const depth = excludeIds.has(item.id) ? 1 : inHub ? 2 : Number.POSITIVE_INFINITY;
      entries.push({ id: item.id, groupId: group.id, depth });
    }
  }
  return entries;
}

export function findDepthViolations(entries: DepthEntry[], maxDepth: number): DepthEntry[] {
  return entries.filter((e) => e.depth > maxDepth);
}

function main(): void {
  // computeMobileDepths/findDepthViolations은 순수 함수라 테스트가 가짜 입력으로 독립
  // 검증한다(AC1 양성대조) — main()은 그 함수들에 실 NAV_GROUPS를 흘려보낼 뿐이다.
  const entries = computeMobileDepths(NAV_GROUPS, MOBILE_HUB_EXCLUDE_IDS, new Set(MOBILE_HUB_GROUP_ORDER));
  const violations = findDepthViolations(entries, MAX_MOBILE_DEPTH);

  console.log(
    `[AC9] 모바일 도달 depth 스캔 — 항목 ${entries.length}개(depth 1: ${entries.filter((e) => e.depth === 1).length}개 · ` +
      `depth 2: ${entries.filter((e) => e.depth === 2).length}개) · 최대 허용 depth=${MAX_MOBILE_DEPTH}`,
  );

  if (violations.length > 0) {
    console.error(`\n❌ depth 초과(도달불가 포함) ${violations.length}건:`);
    for (const v of violations) {
      const label = Number.isFinite(v.depth) ? `depth ${v.depth}` : '도달불가(그룹이 MOBILE_HUB_GROUP_ORDER 밖)';
      console.error(`  - [${v.groupId}] ${v.id} → ${label}`);
    }
    console.error(
      '\n→ nav-config.ts 항목이 MOBILE_HUB_EXCLUDE_IDS 밖인데 그 그룹이 MOBILE_HUB_GROUP_ORDER에 ' +
        '없거나(도달불가), depth 계산 자체가 2를 넘는다. 새 관리면을 추가했다면 그 그룹이 ' +
        'MOBILE_HUB_GROUP_ORDER에 있는지 먼저 확認.',
    );
    process.exit(1);
  }

  console.log(`OK: 전 항목 depth ≤${MAX_MOBILE_DEPTH}(doc §2.4 판별자 충족).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
