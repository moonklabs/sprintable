import type { NavGroupConfig, NavItemConfig } from '@/lib/nav-config';

// story #4885 (UI-2 AC4 PR 1) — 모바일 «전체»(/more)의 구역들 = 사이드바와 같은 한 정의(nav-config.ts NAV_GROUPS) 그대로 + 맨 아래 «그 밖의 화면».
// 예전엔 사이드바에서 빠진 17개를 §② 흡수 지도 소묶음으로 따로 얹었으나(「더보기」 서랍) 서랍을 걷어 내 구역 하나가 사라졌다.
//  - 빼는 항목 = 탭바가 지금 실제로 그리는 탭의 목적지(`excludeIds`, mobile-tab-bar.tsx `tabDestinationNavIds`). 탭에 없는 목적지는 메뉴에 반드시 남는다.
//  - «그 밖의 화면» = 메뉴 입구를 따로 안 만드는 화면들(OTHER_NAV_ITEMS) — 막다른 곳을 만들지 않으려고 «전체» 맨 아래에 둔다.
// 입력을 전부 인자로 받는 순수 함수라(nav-config를 import하지 않는다 — 타입만) 호출부 · 테스트가 같은 원천을 넘긴다.
export const MOBILE_OTHER_CARD_ID = 'other-screens';

export interface MobileHubGroup {
  id: string;
  labelKey?: string;
  items: NavItemConfig[];
}

export function buildMobileHubGroups(input: {
  groups: NavGroupConfig[];
  groupOrder: readonly string[];
  otherItems: NavItemConfig[];
  excludeIds: ReadonlySet<string>;
}): MobileHubGroup[] {
  const { groups, groupOrder, otherItems, excludeIds } = input;
  const hub: MobileHubGroup[] = groupOrder
    .map((groupId) => groups.find((g) => g.id === groupId))
    .filter((g): g is NavGroupConfig => !!g)
    .map((g) => ({ id: g.id, labelKey: g.labelKey, items: g.items.filter((item) => !excludeIds.has(item.id)) }));
  hub.push({ id: MOBILE_OTHER_CARD_ID, labelKey: 'moreOtherScreens', items: otherItems.filter((item) => !excludeIds.has(item.id)) });
  return hub.filter((g) => g.items.length > 0);
}

/**
 * story #4292(유나 관찰 · 선택지 1) — 구역 카드 머리의 한 규칙. 머리 글자가 그 구역의 **유일한 항목 이름과 같으면 머리를 그리지 않는다**
 * (`headerKey: null`) — 사이드바의 «머리 없는 한 항목 구역»(오늘 · 개발 · 결과)과 같은 모양으로, 카드는 항목 줄(이름 + 설명) 하나가 된다.
 * 예전엔 머리 없는 구역이 첫 항목 이름을 머리로 끌어와 «결과 › 결과», «오늘»은 머리 `zoneNow` + 항목 `zoneNow`라 «오늘 › 오늘»이었다.
 * 까디르 QA ①(PO 08:22Z) — 이 규칙의 뜻은 «화면에 같은 글자가 두 번»이라 키가 아니라 **번역된 글자**로 비교한다(`t`를 받는다 ·
 * 다른 키가 같은 글자로 번역돼도 잡는다). `name`은 번역된 구역 이름 — 머리를 안 그릴 때 카드의 접근 이름(aria-label)으로 쓴다(까디르 ②).
 * 검색으로 걸러진 뒤의 구역에도 같은 함수를 부른다(걸러져 한 항목만 남아도 겹치지 않게).
 */
export function sectionHeader(
  group: Pick<MobileHubGroup, 'labelKey' | 'items'>,
  t: (key: string) => string,
): { headerKey: string | null; name: string } {
  const key = group.labelKey ?? group.items[0]?.labelKey;
  const name = key ? t(key) : '';
  const only = group.items.length === 1 ? group.items[0] : undefined;
  if (only && t(only.labelKey) === name) return { headerKey: null, name };
  return { headerKey: key ?? null, name };
}
