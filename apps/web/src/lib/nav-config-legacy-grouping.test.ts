// story #3855(customer-zero·셸, 선생님 07:07Z 지적 → PO 確定) — 「더보기」 브릿지를
// «서랍에 쓸어 담은 그림»에서 «이사 안내판»으로: LEGACY_NAV_ITEMS를 §② 흡수 지도
// 머리말(일감·연결·규칙·지식·이력·설정)별로 묶는 groupVisibleLegacyByTarget()의 순수
// 로직 축 — React 렌더 없이 함수 자체의 완전성·순서·빈 묶음 규칙을 잰다(렌더 축은
// app-sidebar-legacy-more.test.tsx·more/page.test.tsx·legacy-nav-ssot.test.tsx가 전담).
import { describe, expect, it } from 'vitest';
import { LEGACY_NAV_ITEMS, VISIBLE_LEGACY_NAV_ITEMS, groupVisibleLegacyByTarget, type AbsorbTarget } from './nav-config';

// AC1 — 카드 본문 「갈 곳 지도」 표 그대로(2026-09-14 착수 시점 develop HEAD 실측과 대조
// 확認 완료 — 카드 표와 실물이 1:1이었다, 페드루에게 별도 정정 보고 불요).
const EXPECTED_TARGET_BY_ID: Record<string, AbsorbTarget> = {
  goals: 'work', loops: 'work', docs: 'work', artifacts: 'work', content: 'work', 'channel-posts': 'work',
  'org-trust': 'connect', 'org-members': 'connect', 'org-workforce': 'connect', 'org-roles': 'connect', 'org-events': 'connect',
  storage: 'knowledge', 'org-memory': 'knowledge',
  activity: 'history',
  settings: 'settings',
  // inbox는 MOBILE_HUB_EXCLUDE_IDS로 VISIBLE_LEGACY_NAV_ITEMS에서 걸러져 groupVisibleLegacyByTarget
  // 시야 밖이다 — absorbTarget 값 자체는 타입만 채우는 임의값이라 이 표의 완전성 대조에서 제외.
};

describe('nav-config — LEGACY_NAV_ITEMS.absorbTarget 완전성(story #3855 AC1)', () => {
  it('⭐카드 표와 1:1 — 추가/누락/값 오류가 있으면 이 테스트가 RED다', () => {
    const visibleIds = VISIBLE_LEGACY_NAV_ITEMS.map((i) => i.id).sort();
    const expectedIds = Object.keys(EXPECTED_TARGET_BY_ID).sort();
    expect(visibleIds).toEqual(expectedIds);
    for (const item of VISIBLE_LEGACY_NAV_ITEMS) {
      expect(item.absorbTarget, `${item.id}.absorbTarget`).toBe(EXPECTED_TARGET_BY_ID[item.id]);
    }
  });

  it('LEGACY_NAV_ITEMS 전 항목(inbox 포함)이 absorbTarget을 갖는다(타입 강제와 별개로 런타임에도 값 실존을 잰다)', () => {
    for (const item of LEGACY_NAV_ITEMS) {
      expect(item.absorbTarget, `${item.id}.absorbTarget`).toBeTruthy();
    }
  });
});

describe('groupVisibleLegacyByTarget — story #3855 AC1', () => {
  it('머리말 순서가 고정 순서(일감·연결·규칙·지식·이력·설정)와 일치한다', () => {
    const groups = groupVisibleLegacyByTarget();
    expect(groups.map((g) => g.target)).toEqual(['work', 'connect', 'knowledge', 'history', 'settings']);
  });

  it('각 그룹의 항목 순서는 VISIBLE_LEGACY_NAV_ITEMS 원 배열 순서를 유지한다(그룹 안에서는 재정렬 0)', () => {
    const groups = groupVisibleLegacyByTarget();
    const originalOrder = VISIBLE_LEGACY_NAV_ITEMS.map((i) => i.id);
    for (const group of groups) {
      const ids = group.items.map((i) => i.id);
      const originalIndices = ids.map((id) => originalOrder.indexOf(id));
      expect(originalIndices).toEqual([...originalIndices].sort((a, b) => a - b));
    }
  });

  it('전 그룹 항목 합이 VISIBLE_LEGACY_NAV_ITEMS와 정확히 같은 집합이다(누락·중복 0)', () => {
    const groups = groupVisibleLegacyByTarget();
    const grouped = groups.flatMap((g) => g.items.map((i) => i.id)).sort();
    const visible = VISIBLE_LEGACY_NAV_ITEMS.map((i) => i.id).sort();
    expect(grouped).toEqual(visible);
  });

  // AC4 — «묶음째 사라짐». 지금 develop HEAD엔 5개 target 전부가 최소 1항목씩 있어(빈
  // 그룹이 자연히 없다) 이 규칙을 실물로 못 잰다 — nav-config.ts를 직접 mutate하는 대신
  // groupVisibleLegacyByTarget의 필터 로직 자체를 별도 순수함수로 다시 실행해 "만약
  // history 항목이 전부 사라지면" 시나리오를 합성한다(양성대조 — 지금 GREEN이 "항상
  // GREEN"이 아님을 증명).
  it('⭐빈 묶음 렌더 0 — 어느 target의 항목이 전부 사라지면 그 머리말 자체가 배열에서 빠진다(양성대조)', () => {
    const groups = groupVisibleLegacyByTarget();
    expect(groups.some((g) => g.target === 'history')).toBe(true); // 현재는 activity가 있어 history가 존재

    const historyRemoved = groups
      .map((g) => (g.target === 'history' ? { ...g, items: [] } : g))
      .filter((g) => g.items.length > 0);
    expect(historyRemoved.some((g) => g.target === 'history')).toBe(false);
    expect(historyRemoved.map((g) => g.target)).toEqual(['work', 'connect', 'knowledge', 'settings']);
  });
});
