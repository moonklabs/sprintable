import { describe, expect, it } from 'vitest';
import { MOBILE_HUB_EXCLUDE_IDS, MOBILE_HUB_GROUP_ORDER, NAV_GROUPS } from '../src/lib/nav-config';
import { buildMobileNavUniverse, computeMobileDepths, findDepthViolations, MAX_MOBILE_DEPTH, type DepthEntry } from './verify-mobile-nav-depth';

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

// story #3824(UX-v3·FE 1, 페드루 PO 確定 2026-09-13 CI fail 처방) — 5항목 축소로 대부분의
// 관리면(구 19항목 중 17개)이 NAV_GROUPS 밖 LEGACY_NAV_ITEMS로 옮겨갔다. 판별자를
// «삭제»가 아니라 **«확장»**한다(PO 명시 문구) — NAV_GROUPS ∪ LEGACY_NAV_ITEMS를 대상으로
// "모바일에서 모든 관리 항목 depth ≤2" 불변식을 그대로 유지한다. LEGACY_NAV_ITEMS는
// more/page.tsx가 "그 밖의 화면" 카드 하나로 항상 렌더(MOBILE_HUB_GROUP_ORDER 조회 대상이
// 아니라 무조건 추가)하므로 합성 legacy 그룹으로 모델링(buildMobileNavUniverse() 참고) —
// 이 합성 그룹이 hubGroupIds에서 빠지면 여전히 도달불가(∞)로 RED 난다(완화 아님).
describe('실 NAV_GROUPS ∪ LEGACY_NAV_ITEMS — story #2684 AC3 판별자, story #3824로 확장(이벤트 포함 전 관리면 depth ≤2)', () => {
  const { groups, hubGroupIds } = buildMobileNavUniverse();

  // story #3824 — NAV_GROUPS(5) + LEGACY_NAV_ITEMS(18) = 23항목(nav-config-descriptions.
  // test.ts의 "정확히 23개다" 판정과 동일 총량 — 재분배만 있었지 증감 없음을 이 축에서도
  // 재확認). 챗 center(CHAT_CENTER_ITEM)는 여전히 이 스캔 대상 밖(story #2930 I2, 상단
  // ㉥ 참고 — nav-config.ts 어느 배열에도 없어 원래도 시야 밖).
  // story #3845(§①④, 2026-09-14) — retro·standup이 「일감」 탭으로 흡수되며 LEGACY_NAV_
  // ITEMS 18→16, 총량 23→21(nav-config-descriptions.test.ts와 동일 축, 동일 사유).
  it('전 21항목(챗 center 제외)이 depth ≤2다(회귀 0 — 도달불가 0건 포함)', () => {
    const entries = computeMobileDepths(groups, MOBILE_HUB_EXCLUDE_IDS, hubGroupIds);
    expect(entries).toHaveLength(21);
    expect(findDepthViolations(entries, MAX_MOBILE_DEPTH)).toEqual([]);
  });

  it('이벤트(판별자 자체, 이제 LEGACY_NAV_ITEMS 소속)는 depth 2다 — /more 「그 밖의 화면」 경유', () => {
    const entries = computeMobileDepths(groups, MOBILE_HUB_EXCLUDE_IDS, hubGroupIds);
    const events = entries.find((e) => e.id === 'org-events');
    expect(events?.depth).toBe(2);
  });

  // story #3824 — inbox는 이제 LEGACY_NAV_ITEMS 소속이지만 MOBILE_HUB_EXCLUDE_IDS엔 여전히
  // 있어(바텀 탭 「결재」가 이미 depth 1로 커버) 어느 배열에 살든 depth 1 그대로다. board도
  // NAV_GROUPS 소속인 채 동일 취급 — "바텀 탭 커버 축"은 소속 배열과 무관하다는 것 자체가
  // 이 판별자의 핵심 불변식.
  it('board·inbox는 depth 1이고 그 외는 전부 depth 2다(바텀 탭 축과 정확히 일치, 소속 배열 무관)', () => {
    const entries = computeMobileDepths(groups, MOBILE_HUB_EXCLUDE_IDS, hubGroupIds);
    const depth1Ids = entries.filter((e) => e.depth === 1).map((e) => e.id).sort();
    expect(depth1Ids).toEqual(['board', 'inbox']);
    expect(entries.filter((e) => e.depth === 2).length).toBe(entries.length - 2);
  });

  it('NAV_GROUPS의 모든 그룹 id가 MOBILE_HUB_GROUP_ORDER에 있다(도달불가 0건 실증, 실 그룹 축)', () => {
    const navGroupIds = new Set(NAV_GROUPS.map((g) => g.id));
    const realHubGroupIds = new Set(MOBILE_HUB_GROUP_ORDER);
    for (const id of navGroupIds) expect(realHubGroupIds.has(id)).toBe(true);
  });

  it('합성 legacy 그룹이 hubGroupIds에서 빠지면 그 즉시 도달불가(∞)로 RED — 완화 아님을 자가증명(양성대조)', () => {
    const hubGroupIdsWithoutLegacy = new Set(MOBILE_HUB_GROUP_ORDER);
    const entries = computeMobileDepths(groups, MOBILE_HUB_EXCLUDE_IDS, hubGroupIdsWithoutLegacy);
    const violations = findDepthViolations(entries, MAX_MOBILE_DEPTH);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((v) => v.depth === Number.POSITIVE_INFINITY)).toBe(true);
  });
});
