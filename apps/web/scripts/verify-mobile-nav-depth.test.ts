import { describe, expect, it } from 'vitest';
import { MOBILE_HUB_EXCLUDE_IDS, MOBILE_HUB_GROUP_ORDER, NAV_GROUPS } from '../src/lib/nav-config';
import { computeMobileDepths, findDepthViolations, MAX_MOBILE_DEPTH, type DepthEntry } from './verify-mobile-nav-depth';

describe('computeMobileDepths — story #2684', () => {
  it('MOBILE_HUB_EXCLUDE_IDS 항목은 depth 1(바텀 탭 직행)', () => {
    const groups = [{ id: 'work', items: [{ id: 'flow' }] }];
    expect(computeMobileDepths(groups, new Set(['flow']), new Set(['work']))).toEqual([
      { id: 'flow', groupId: 'work', depth: 1 },
    ]);
  });

  it('제외 안 됐고 그룹이 허브 순서에 있으면 depth 2(전체 탭 1 + 허브 내 선택 1)', () => {
    const groups = [{ id: 'organization', items: [{ id: 'org-events' }] }];
    expect(computeMobileDepths(groups, new Set(), new Set(['organization']))).toEqual([
      { id: 'org-events', groupId: 'organization', depth: 2 },
    ]);
  });

  // story #2684 핵심 발견 — 항목을 실제로 3탭짜리 서브메뉴에 옮기는 것보다, nav-config.ts에
  // 새 관리면을 추가하면서 MOBILE_HUB_GROUP_ORDER 갱신을 깜빡하는 실수가 훨씬 현실적이다.
  // 그룹이 허브 순서 밖이면 그 그룹의 항목 전체가 «도달불가»(depth ∞)다.
  it('그룹이 MOBILE_HUB_GROUP_ORDER 밖이면 도달불가(depth Infinity)', () => {
    const groups = [{ id: 'organization', items: [{ id: 'org-events' }] }];
    const entries = computeMobileDepths(groups, new Set(), new Set(['work'])); // 'organization' 없음
    expect(entries).toEqual([{ id: 'org-events', groupId: 'organization', depth: Number.POSITIVE_INFINITY }]);
  });
});

describe('findDepthViolations — story #2684 AC1(양성대조)', () => {
  it('3탭으로 밀린 픽스처(depth 3)는 RED를 낸다', () => {
    const fake: DepthEntry[] = [{ id: 'org-events', groupId: 'organization', depth: 3 }];
    expect(findDepthViolations(fake, MAX_MOBILE_DEPTH)).toEqual(fake);
  });

  it('허브 순서에서 빠져 도달불가(Infinity)가 된 픽스처도 RED를 낸다', () => {
    const fake: DepthEntry[] = [{ id: 'org-events', groupId: 'organization', depth: Number.POSITIVE_INFINITY }];
    expect(findDepthViolations(fake, MAX_MOBILE_DEPTH)).toEqual(fake);
  });

  it('허용 depth 이하는 통과한다', () => {
    const fake: DepthEntry[] = [
      { id: 'flow', groupId: 'work', depth: 1 },
      { id: 'org-events', groupId: 'organization', depth: 2 },
    ];
    expect(findDepthViolations(fake, MAX_MOBILE_DEPTH)).toEqual([]);
  });

  it('경계값(depth === maxDepth)은 위반이 아니다', () => {
    expect(findDepthViolations([{ id: 'x', groupId: 'g', depth: 2 }], 2)).toEqual([]);
  });
});

describe('실 NAV_GROUPS — story #2684 AC3 판별자(이벤트 포함 전 관리면 depth ≤2)', () => {
  const hubGroupIds = new Set(MOBILE_HUB_GROUP_ORDER);

  // story #2930(P0-G) I2 — chats가 NAV_GROUPS 자체에서 빠져(사이드바/모바일 챗 center로
  // 승격) 21→20항목. 챗 center 자신의 depth 1(바텀 탭바 FAB — 어떤 탭 안에도 안 묻힌 직행
  // 위치)은 이 순수 데이터 스캔의 시야 밖이라 이 스위트가 못 잰다(nav-config.ts 상단
  // "AC2 — 이 가드가 못 잡는 것" ㉢류와 동형 — MobileTabBar 구조 자체는 별도 관심사). 실제
  // FAB 배선의 depth-1 대응 검증은 mobile-tab-bar.test.ts의 챗 FAB 왕복 회귀가드가 맡는다.
  it('전 20항목(챗 center 제외)이 depth ≤2다(회귀 0 — 도달불가 0건 포함)', () => {
    const entries = computeMobileDepths(NAV_GROUPS, MOBILE_HUB_EXCLUDE_IDS, hubGroupIds);
    expect(findDepthViolations(entries, MAX_MOBILE_DEPTH)).toEqual([]);
  });

  it('이벤트(판별자 자체)는 depth 2다', () => {
    const entries = computeMobileDepths(NAV_GROUPS, MOBILE_HUB_EXCLUDE_IDS, hubGroupIds);
    const events = entries.find((e) => e.id === 'org-events');
    expect(events?.depth).toBe(2);
  });

  // story #2930 I2 — 'chats'는 이제 NAV_GROUPS에 없어(챗 center 승격) 이 스캔 대상 밖이다.
  // MOBILE_HUB_EXCLUDE_IDS엔 방어적으로 'chats'가 여전히 남아있지만(nav-config.ts 주석 참고)
  // 매칭될 항목 자체가 없어 depth1Ids엔 안 잡힌다.
  it('flow·inbox는 depth 1이고 그 외는 전부 depth 2다(바텀 탭 축과 정확히 일치)', () => {
    const entries = computeMobileDepths(NAV_GROUPS, MOBILE_HUB_EXCLUDE_IDS, hubGroupIds);
    const depth1Ids = entries.filter((e) => e.depth === 1).map((e) => e.id).sort();
    expect(depth1Ids).toEqual(['flow', 'inbox']);
    expect(entries.filter((e) => e.depth === 2).length).toBe(entries.length - 2);
  });

  it('NAV_GROUPS의 모든 그룹 id가 MOBILE_HUB_GROUP_ORDER에 있다(도달불가 0건 실증)', () => {
    const navGroupIds = new Set(NAV_GROUPS.map((g) => g.id));
    for (const id of navGroupIds) expect(hubGroupIds.has(id)).toBe(true);
  });
});
