// story #4278(유나 결정 ①②) — 모바일 «전체» 구역을 실 nav-config로 돈다. 빼는 항목은 탭바가 실제로 그리는 탭의 목적지 ·
// 탭에 없는 목적지는 메뉴에 반드시 · «연결·규칙»은 한 구역(그 밖의 화면에서 소묶음 빠짐).
// 뮤테이션: ① 제외를 옛 고정 목록(board · inbox · chats)으로 되돌리면 ON 케이스 RED ② 연결 소묶음 합치기를 빼면 «연결·규칙»이 두 번.
import { describe, expect, it } from 'vitest';
import { groupVisibleLegacyByTarget, LEGACY_NAV_ITEMS, MOBILE_HUB_GROUP_ORDER, resolveNavGroups } from '@/lib/nav-config';
import { DEFAULT_NAV_V3_FLAGS, type NavV3Flags } from '@/lib/nav-v3-destinations';
import { tabDestinationNavIds } from '@/components/nav/mobile-tab-bar';
import { buildMobileHubGroups, MOBILE_LEGACY_CARD_ID, sectionHeaderKey } from './mobile-hub-groups';

const ON: NavV3Flags = { todayV3Enabled: true, chatV3Enabled: true, connectRulesV3Enabled: true };

function hub(flags: NavV3Flags) {
  return buildMobileHubGroups({
    groups: resolveNavGroups(flags),
    groupOrder: MOBILE_HUB_GROUP_ORDER,
    legacyGroups: groupVisibleLegacyByTarget(),
    legacyItems: LEGACY_NAV_ITEMS,
    excludeIds: tabDestinationNavIds(flags),
  });
}
const ids = (g: ReturnType<typeof hub>[number] | undefined) => (g?.items ?? []).map((i) => i.id);

describe('buildMobileHubGroups(story #4278)', () => {
  it('탭 목적지만 뺀다 — OFF(일감 · 결재 · 대화): 보드 · 결재함 · 대화 빠짐 · «오늘»은 메뉴에', () => {
    expect(tabDestinationNavIds(DEFAULT_NAV_V3_FLAGS)).toEqual(new Set(['board', 'inbox', 'chats']));
    const g = hub(DEFAULT_NAV_V3_FLAGS);
    const all = g.flatMap(ids);
    expect(all).not.toContain('board');
    expect(all).not.toContain('inbox');
    expect(ids(g.find((x) => x.id === 'now'))).toEqual(['org-briefing']);
  });

  it('⭐ON(오늘 · 대화 · 일감): «오늘»(org-briefing) · 보드는 빠지고 결재함은 «오늘» 구역에 — 탭에 없는 목적지는 메뉴에 반드시', () => {
    expect(tabDestinationNavIds(ON)).toEqual(new Set(['org-briefing', 'chats', 'board']));
    const g = hub(ON);
    const now = g.find((x) => x.id === 'now');
    expect(now?.labelKey).toBe('zoneNow');
    expect(ids(now)).toEqual(['inbox']);
    const all = g.flatMap(ids);
    expect(all).not.toContain('org-briefing');
    expect(all.filter((id) => id === 'inbox')).toHaveLength(1); // «설정» 소묶음으로 떨어지지 않는다
  });

  it.each([['OFF', DEFAULT_NAV_V3_FLAGS], ['ON', ON]] as const)('⭐«연결·규칙» 한 구역(%s) — 끝에 에이전트 · 신뢰 센터 · 레시피 · 그 밖의 화면엔 연결 소묶음 없음', (_label, flags) => {
    const g = hub(flags);
    const connect = ids(g.find((x) => x.id === 'connect-rules'));
    expect(connect.slice(-3)).toEqual(['org-workforce', 'org-trust', 'org-events']);
    const legacy = g.find((x) => x.id === MOBILE_LEGACY_CARD_ID);
    expect(legacy?.subgroups?.map((sg) => sg.target)).not.toContain('connect');
    const headings = g.map((x) => x.labelKey).concat(legacy?.subgroups?.map((sg) => sg.labelKey) ?? []);
    expect(headings.filter((k) => k === 'zoneConnectRules')).toHaveLength(1);
  });

  it('ON 구역 첫 항목은 «모아 보기»(구역 이름과 같은 «연결·규칙» 항목이 아니다)', () => {
    const connect = hub(ON).find((x) => x.id === 'connect-rules');
    expect(connect?.items[0]).toMatchObject({ id: 'connect-rules-v3', labelKey: 'connectRulesOverview' });
    expect(connect?.items.some((i) => i.labelKey === 'zoneConnectRules')).toBe(false);
  });

  it('구역이 없으면(가짜 카탈로그) 연결 소묶음은 그 밖의 화면에 그대로 — 항목을 잃지 않는다', () => {
    const g = buildMobileHubGroups({
      groups: [], groupOrder: [], legacyGroups: groupVisibleLegacyByTarget(), legacyItems: LEGACY_NAV_ITEMS, excludeIds: new Set(),
    });
    expect(g.find((x) => x.id === MOBILE_LEGACY_CARD_ID)?.subgroups?.map((sg) => sg.target)).toContain('connect');
  });

  it('모든 목적지는 탭이나 메뉴 어딘가에 — 플래그 둘 다(메뉴 항목 + 탭 목적지 = 5구역 항목 전부 + 레거시 전부)', () => {
    for (const flags of [DEFAULT_NAV_V3_FLAGS, ON]) {
      const inMenu = new Set(hub(flags).flatMap(ids));
      const inTabs = tabDestinationNavIds(flags);
      const everything = [...resolveNavGroups(flags).flatMap((g) => g.items.map((i) => i.id)), ...LEGACY_NAV_ITEMS.map((i) => i.id)];
      const lost = everything.filter((id) => !inMenu.has(id) && !inTabs.has(id));
      expect(lost, JSON.stringify(flags)).toEqual([]);
    }
  });
});

// story #4292(유나 1안 확정) — 판정 한 조건: 보이는 항목 1 ∧ 그 이름 = 머리 → 머리 없음. 이름이 다르면 머리 유지 · 여러 항목이면 머리 유지.
// 뮤테이션: sectionHeaderKey가 늘 머리를 돌려주면(예전 동작) 첫 두 줄이 RED · 한 항목이면 늘 null이면 «이름 다른 한 항목» 줄이 RED.
describe('sectionHeaderKey(story #4292)', () => {
  const byId = (flags: NavV3Flags, id: string) => hub(flags).find((x) => x.id === id)!;

  it('⭐OFF «오늘»(브리핑 하나 · 머리 zoneNow = 항목 zoneNow) — 머리 없음', () => {
    const now = byId(DEFAULT_NAV_V3_FLAGS, 'now');
    expect(ids(now)).toEqual(['org-briefing']);
    expect(sectionHeaderKey(now)).toBeNull();
  });

  it('⭐ON «결과»(머리 없는 한 항목 구역) — 예전엔 항목 이름을 머리로 끌어와 «결과 › 결과», 이제 머리 없음', () => {
    const results = byId(ON, 'results');
    expect(results.labelKey).toBeUndefined();
    expect(results.items).toHaveLength(1);
    expect(sectionHeaderKey(results)).toBeNull();
  });

  it('검색으로 한 항목만 남아 그 이름이 머리와 같아도 — 머리 없음(거른 뒤에도 같은 함수)', () => {
    const now = byId(DEFAULT_NAV_V3_FLAGS, 'now');
    expect(sectionHeaderKey({ ...now, items: now.items.filter((i) => i.labelKey === 'zoneNow') })).toBeNull();
  });

  it('남은 한 항목 이름이 머리와 다르면 머리 유지(어느 구역인지가 정보) — ON «오늘 › 결재함» · 연결·규칙에서 하나만 남을 때', () => {
    const now = byId(ON, 'now');
    expect(ids(now)).toEqual(['inbox']);
    expect(sectionHeaderKey(now)).toBe('zoneNow');
    const connect = byId(ON, 'connect-rules');
    expect(sectionHeaderKey({ ...connect, items: connect.items.slice(0, 1) })).toBe('zoneConnectRules');
  });

  it('여러 항목 구역은 머리 그대로 · 모든 카드가 머리 없음이 되지는 않는다(구역 수 = 카드 수는 그대로)', () => {
    for (const flags of [DEFAULT_NAV_V3_FLAGS, ON]) {
      const g = hub(flags);
      for (const group of g.filter((x) => x.items.length > 1)) {
        expect(sectionHeaderKey(group)).toBe(group.labelKey ?? group.items[0]!.labelKey);
      }
    }
  });
});

