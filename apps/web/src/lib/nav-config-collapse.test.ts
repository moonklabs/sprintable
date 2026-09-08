import { describe, expect, it } from 'vitest';
import {
  computeActiveZoneCollapsedGroupIds,
  NAV_GROUPS,
  SIDEBAR_EXPAND_NOW_MIN_VIEWPORT_HEIGHT,
  SIDEBAR_NOW_GROUP_ID,
  type GroupItemCount,
} from './nav-config';

// story #d986fd6c(IA·S4, PO 정정 2026-09-08 07:19Z) — budget-누적 규칙(순서 고정)을 유나의
// 라이브 실측(필요 뷰포트=615.5+32×N)이 반증해 「현재 구역 인지 + 뷰포트 조건」으로
// 교체했다. 기본 = 활성 구역만 펼침, 뷰포트 ≥872px면 「오늘」도 얹는다(배포 55 라이브
// 재실측으로 840→872 정정 — N 정의 누락분 상시 행(설정) 1개 보정, 유나 § 12:52Z).
describe('computeActiveZoneCollapsedGroupIds — story #d986fd6c(IA·S4 AC1 규칙, 유나 실측 반영)', () => {
  const groups: GroupItemCount[] = [
    { id: 'now', itemCount: 2 },
    { id: 'dev', itemCount: 5 },
    { id: 'marketing', itemCount: 5 },
    { id: 'trust', itemCount: 2 },
    { id: 'knowledge', itemCount: 4 },
    { id: 'organization', itemCount: 5 },
    { id: 'settings', itemCount: 1 },
  ];

  it('활성 구역만 펼치고 나머지는 전부 접는다(뷰포트 미달·미측정)', () => {
    const collapsed = computeActiveZoneCollapsedGroupIds({ groups, activeGroupId: 'dev', viewportHeight: 700 });
    expect(collapsed).toEqual(new Set(['now', 'marketing', 'trust', 'knowledge', 'organization', 'settings']));
  });

  it('뷰포트 미측정(null, 마운트 前)이면 활성 구역만 펼치고 「오늘」은 안 얹는다(SSR 안전 기본값)', () => {
    const collapsed = computeActiveZoneCollapsedGroupIds({ groups, activeGroupId: 'marketing', viewportHeight: null });
    expect(collapsed.has('now')).toBe(true);
    expect(collapsed.has('marketing')).toBe(false);
  });

  it('뷰포트 ≥872이면 활성 구역+「오늘」 둘 다 펼친다', () => {
    const collapsed = computeActiveZoneCollapsedGroupIds({ groups, activeGroupId: 'organization', viewportHeight: 872 });
    expect(collapsed.has('organization')).toBe(false);
    expect(collapsed.has('now')).toBe(false);
    expect(collapsed).toEqual(new Set(['dev', 'marketing', 'trust', 'knowledge', 'settings']));
  });

  it('뷰포트 871(문턱 바로 아래)면 「오늘」은 안 얹는다(경계값)', () => {
    const collapsed = computeActiveZoneCollapsedGroupIds({ groups, activeGroupId: 'organization', viewportHeight: 871 });
    expect(collapsed.has('now')).toBe(true);
  });

  // 배포 55 라이브 결함 회귀(페드루 PO 明示) — 옛 문턱값(840)이 실제로는 N=8(활성
  // 5+오늘 2+상시 행 1)에서 스크롤을 유발했다. 840은 이제 새 문턱(872) 아래라 「오늘」이
  // 안 얹혀야 한다(상시 행 「설정」은 app-sidebar.tsx가 labelKey 없는 그룹을 collapsedGroupIds
  // 와 무관하게 항상 그리는 별도 규칙이라 — 이 순수 함수 테스트가 아니라 DOM 레벨
  // 회귀는 app-sidebar.test.tsx에 짝을 둔다).
  it('뷰포트 840(옛 문턱값)에서 「오늘」이 안 얹힌다(배포 55 라이브 결함 회귀 — 새 문턱 872 미만)', () => {
    const collapsed = computeActiveZoneCollapsedGroupIds({ groups, activeGroupId: 'organization', viewportHeight: 840 });
    expect(collapsed.has('now')).toBe(true);
  });

  it('활성 구역이 이미 「오늘」이면(오늘 화면 보는 중) 뷰포트 무관하게 한 번만 펼친다(집합이라 중복 없음)', () => {
    const collapsed = computeActiveZoneCollapsedGroupIds({ groups, activeGroupId: 'now', viewportHeight: 700 });
    expect(collapsed.has('now')).toBe(false);
    expect(collapsed.size).toBe(6);
  });

  it('활성 구역이 null이면(챗 center·설정처럼 그룹 밖 라우트) 뷰포트 미달 시 전 구역 접힘', () => {
    const collapsed = computeActiveZoneCollapsedGroupIds({ groups, activeGroupId: null, viewportHeight: 700 });
    expect(collapsed).toEqual(new Set(groups.map((g) => g.id)));
  });

  it('활성 구역이 null이어도 뷰포트 ≥872이면 「오늘」은 펼친다', () => {
    const collapsed = computeActiveZoneCollapsedGroupIds({ groups, activeGroupId: null, viewportHeight: 900 });
    expect(collapsed.has('now')).toBe(false);
  });

  it('빈 구역 배열도 죽지 않는다(경계값)', () => {
    expect(computeActiveZoneCollapsedGroupIds({ groups: [], activeGroupId: 'dev', viewportHeight: 900 })).toEqual(new Set());
  });

  it('SIDEBAR_EXPAND_NOW_MIN_VIEWPORT_HEIGHT는 872이다(유나 실측 615.5+32×8=871.5 반올림, N=8=활성5+오늘2+상시행1, 임의 수 아님)', () => {
    expect(SIDEBAR_EXPAND_NOW_MIN_VIEWPORT_HEIGHT).toBe(872);
  });

  it('SIDEBAR_NOW_GROUP_ID는 실 NAV_GROUPS의 첫 구역 id와 일치한다(회귀가드)', () => {
    expect(SIDEBAR_NOW_GROUP_ID).toBe(NAV_GROUPS[0]!.id);
  });

  it('실 NAV_GROUPS 최대 구역 크기는 5다(활성 구역 단독 펼침이 872 문턱 없이도 항상 807.5px 이하로 들어간다는 전제 회귀가드)', () => {
    const maxItems = Math.max(...NAV_GROUPS.map((g) => g.items.length));
    expect(maxItems).toBe(5);
  });

  it('실 NAV_GROUPS 항목 수 합은 24다(회귀 시 이 값부터 어긋난다)', () => {
    const total = NAV_GROUPS.reduce((sum, g) => sum + g.items.length, 0);
    expect(total).toBe(24);
  });
});
