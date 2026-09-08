import { describe, expect, it } from 'vitest';
import { computeDefaultCollapsedGroupIds, NAV_GROUPS, SIDEBAR_FIRST_SCREEN_ITEM_BUDGET, type GroupItemCount } from './nav-config';

// story #d986fd6c(IA·S4, PO 確定 2026-09-08) — 규칙(이 함수)과 임계값(SIDEBAR_FIRST_SCREEN_
// ITEM_BUDGET)을 분리했다. 규칙: NAV_GROUPS 순서대로(위에서부터) 항목을 누적하다 예산을
// 넘기는 첫 구역부터 그 구역과 그 뒤 전부를 기본 접힘으로 둔다.
describe('computeDefaultCollapsedGroupIds — story #d986fd6c(IA·S4 AC1 규칙)', () => {
  const groups: GroupItemCount[] = [
    { id: 'now', itemCount: 2 },
    { id: 'dev', itemCount: 5 },
    { id: 'marketing', itemCount: 5 },
    { id: 'trust', itemCount: 2 },
    { id: 'knowledge', itemCount: 4 },
    { id: 'organization', itemCount: 5 },
    { id: 'settings', itemCount: 1 },
  ];

  it('예산이 넉넉하면(전 항목 합 이상) 아무 구역도 안 접힌다', () => {
    expect(computeDefaultCollapsedGroupIds(groups, 24)).toEqual(new Set());
  });

  it('예산이 0이면 전 구역이 접힌다(첫 구역부터 이미 초과)', () => {
    expect(computeDefaultCollapsedGroupIds(groups, 0)).toEqual(new Set(['now', 'dev', 'marketing', 'trust', 'knowledge', 'organization', 'settings']));
  });

  it('예산이 구역 경계에 정확히 걸치면 그 구역까지는 펼치고 다음부터 접는다(now 2 + dev 5 = 7)', () => {
    const collapsed = computeDefaultCollapsedGroupIds(groups, 7);
    expect(collapsed).toEqual(new Set(['marketing', 'trust', 'knowledge', 'organization', 'settings']));
  });

  it('예산이 구역 중간에서 끊기면(now 2 + dev 5 = 7, +marketing 5=12인데 예산 9) 그 구역부터 접는다(부분 렌더 없음 — 구역 단위)', () => {
    const collapsed = computeDefaultCollapsedGroupIds(groups, 9);
    expect(collapsed).toEqual(new Set(['marketing', 'trust', 'knowledge', 'organization', 'settings']));
  });

  it('한 번 접기 시작하면 뒤 구역은 예산과 무관하게 전부 접힌다(순서 우선 — 임의 선택 없음)', () => {
    // trust(2)만 보면 남는 예산에 들어갈 수 있어도, marketing에서 이미 넘겼으므로 접힘.
    const collapsed = computeDefaultCollapsedGroupIds(groups, 8);
    expect(collapsed.has('marketing')).toBe(true);
    expect(collapsed.has('trust')).toBe(true);
  });

  it('빈 예산 배열도 죽지 않는다(경계값)', () => {
    expect(computeDefaultCollapsedGroupIds([], 5)).toEqual(new Set());
  });

  // budget=12 확定(PO, 배포 54 dev-app 실측 뒤 2026-09-08) — 근거는 nav-config.ts::
  // SIDEBAR_FIRST_SCREEN_ITEM_BUDGET 정의부 주석. 뷰포트 픽셀(1440×800→11, 1440×900→12)
  // 이 아니라 «구역 성격»(주력 3구역 오늘·개발·마케팅 항목 합=12) 기준으로 PO가 골랐다 —
  // 이 테스트는 그 값이 임의로 흔들리면 잡는다.
  it('SIDEBAR_FIRST_SCREEN_ITEM_BUDGET은 12다(주력 3구역 오늘2+개발5+마케팅5 합, PO 확定 근거는 정의부 참고)', () => {
    expect(SIDEBAR_FIRST_SCREEN_ITEM_BUDGET).toBe(12);
  });

  it('실 NAV_GROUPS 항목 수 합은 24다(회귀 시 이 값부터 어긋난다)', () => {
    const total = NAV_GROUPS.reduce((sum, g) => sum + g.items.length, 0);
    expect(total).toBe(24);
  });

  // 실 NAV_GROUPS + 확定 budget으로 규칙을 돌리면 PO가 의도한 정확히 그 결과가 나온다는
  // 통합 회귀가드 — 순수 함수 단위 테스트(위)와 실제 배선(app-sidebar.tsx)을 잇는다.
  it('실 NAV_GROUPS·budget=12로 규칙을 돌리면 신뢰·지식·조직·설정이 접히고 오늘·개발·마케팅은 펼쳐진다', () => {
    const collapsed = computeDefaultCollapsedGroupIds(
      NAV_GROUPS.map((g) => ({ id: g.id, itemCount: g.items.length })),
      SIDEBAR_FIRST_SCREEN_ITEM_BUDGET!,
    );
    expect(collapsed).toEqual(new Set(['trust', 'knowledge', 'organization', 'settings']));
  });
});
