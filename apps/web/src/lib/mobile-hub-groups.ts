import type { LegacyNavGroup, LegacyNavItemConfig, NavGroupConfig, NavItemConfig } from '@/lib/nav-config';

// story #4278(유나 결정 ①②) — 모바일 «전체»(/more)의 구역들. 예전엔 NAV_GROUPS(플래그 무관) + 고정 제외(MOBILE_HUB_EXCLUDE_IDS)라
// 플래그 ON에서 «결재함»이 탭에도 메뉴에도 없고 «오늘»이 둘 다에 있었다. 이제:
//  - 구역은 사이드바와 같은 resolveNavGroups(flags)(플래그별 목적지 · v3 «모아 보기» 항목) — 호출부가 넘긴다.
//  - 빼는 항목 = 탭바가 지금 실제로 그리는 탭의 목적지(`excludeIds`, mobile-tab-bar.tsx `tabDestinationNavIds`). 탭에 없는
//    목적지는 메뉴에 반드시 남는다 — 결재함(inbox)이 탭에 없으면 «오늘» 구역에 둔다.
//  - «그 밖의 화면 › 연결·규칙» 소묶음(에이전트 · 신뢰 센터 · 레시피)은 위 «연결·규칙» 구역 끝에 이어 붙인다(한 구역이 두 곳에
//    나뉘어 이름이 두 번 보이던 것). 그 구역이 없으면(예: 가짜 카탈로그) 소묶음을 그대로 둔다 — 항목을 잃지 않는다.
// 입력을 전부 인자로 받는 순수 함수라(nav-config를 import하지 않는다 — 타입만) 호출부 · 테스트가 같은 원천을 넘긴다.
// 데스크톱 «더보기»(groupVisibleLegacyByTarget)는 그대로다.
export const MOBILE_LEGACY_CARD_ID = 'legacy-other-screens';
const CONNECT_TAIL_ORDER = ['org-workforce', 'org-trust', 'org-events'];

export interface MobileHubGroup {
  id: string;
  labelKey?: string;
  items: Array<NavItemConfig | LegacyNavItemConfig>;
  subgroups?: LegacyNavGroup[];
}

export function buildMobileHubGroups(input: {
  groups: NavGroupConfig[];
  groupOrder: readonly string[];
  legacyGroups: LegacyNavGroup[];
  legacyItems: LegacyNavItemConfig[];
  excludeIds: ReadonlySet<string>;
}): MobileHubGroup[] {
  const { groups, groupOrder, legacyGroups, legacyItems, excludeIds } = input;
  const inbox = legacyItems.find((item) => item.id === 'inbox');
  const inboxInMenu = inbox && !excludeIds.has('inbox') ? [inbox] : [];
  const hasConnectSection = groupOrder.includes('connect-rules') && groups.some((g) => g.id === 'connect-rules');
  const connectGroup = legacyGroups.find((sg) => sg.target === 'connect');
  const connectTail = hasConnectSection && connectGroup
    ? [...connectGroup.items].sort((a, b) => rank(a.id) - rank(b.id))
    : [];

  const hub: MobileHubGroup[] = groupOrder
    .map((groupId) => groups.find((g) => g.id === groupId))
    .filter((g): g is NavGroupConfig => !!g)
    .map((g) => {
      const items: MobileHubGroup['items'] = g.items.filter((item) => !excludeIds.has(item.id));
      if (g.id === 'now') return { id: g.id, labelKey: 'zoneNow', items: [...items, ...inboxInMenu] };
      if (g.id === 'connect-rules') return { id: g.id, labelKey: g.labelKey, items: [...items, ...connectTail] };
      return { id: g.id, labelKey: g.labelKey, items };
    });
  const subgroups = legacyGroups
    .filter((sg) => !(hasConnectSection && sg.target === 'connect'))
    .map((sg) => ({ ...sg, items: sg.items.filter((item) => !excludeIds.has(item.id)) }))
    .filter((sg) => sg.items.length > 0);
  hub.push({ id: MOBILE_LEGACY_CARD_ID, labelKey: 'moreOtherScreens', items: subgroups.flatMap((sg) => sg.items), subgroups });
  return hub.filter((g) => g.items.length > 0);
}

function rank(id: string): number {
  const i = CONNECT_TAIL_ORDER.indexOf(id);
  return i === -1 ? CONNECT_TAIL_ORDER.length : i;
}
