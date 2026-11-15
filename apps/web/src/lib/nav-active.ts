// story #4885 (UI-2) — «지금 여기» 판정의 한 곳. 어떤 셸(왼쪽 길잡이 · 아이콘 막대 · 위쪽 탭)이 그려도 같은 규칙을 쓴다: 그리는 쪽이 바뀌어도 판정은 한 벌.
//  · 정적 항목: 경로(쿼리 뗀)가 지금 주소와 같거나 그 하위이고, 항목 경로가 쿼리(`?tab=gates`)를 가지면 지금 주소의 같은 키가 같은 값일 때만 맞다. 맞는 항목이 여럿이면 **가장 구체적인 하나**(경로 가장 긴 · 쿼리 있는)만 켠다. 정확히 맞는 항목이 없으면 같은 화면의 가장 구체적인 항목(탭만 다른 경우)을 켠다.
//  · 자원(`/{ws}/{proj}/{자원}`) 항목: 직접 경로 또는 flat 경로가 지금 주소와 같거나 그 하위. 일감처럼 탭줄을 가진 항목은 탭 경로들(extra)까지 본다.
import type { NavItemConfig } from './nav-config';
import { resolveChatsHref } from './nav-v3-destinations';

// kind가 없는 항목(예: «전체» ALL_SCREENS_ITEM — 구역 항목이 아니라 입구 하나)은 정적으로 본다. 자원 항목만 건너뛴다.
export function findActiveStaticItemId(items: ReadonlyArray<Pick<NavItemConfig, 'id' | 'path'> & { kind?: NavItemConfig['kind'] }>, pathname: string, search: URLSearchParams): string | null {
  let best: { id: string; weight: number } | null = null;
  // 같은 화면의 다른 탭(예: /inbox의 «알림» 탭 · 탭 없는 /inbox)은 항목 쿼리(?tab=gates)와 안 맞지만 «이 화면 안»이다 — 정확히 맞는 항목이 하나도 없을 때만, 경로가 맞는 가장 구체적인 항목을 켠다(위치를 잃지 않게).
  let sameScreen: { id: string; weight: number } | null = null;
  for (const item of items) {
    if (item.kind === 'resource') continue;
    const [route, query = ''] = item.path.split('?') as [string, string | undefined];
    if (!(pathname === route || (route !== '/' && pathname.startsWith(`${route}/`)))) continue;
    const weight = route.length * 2 + (query ? 1 : 0);
    const wanted = new URLSearchParams(query);
    if ([...wanted].some(([key, value]) => search.get(key) !== value)) {
      if (!sameScreen || weight > sameScreen.weight) sameScreen = { id: item.id, weight };
      continue;
    }
    if (!best || weight > best.weight) best = { id: item.id, weight };
  }
  return (best ?? sameScreen)?.id ?? null;
}

export function isResourceItemActive(pathname: string, resource: string, orgSlug: string | undefined, projectSlug: string | undefined, extra: readonly string[] = []): boolean {
  const isActivePath = (p: string) => pathname === `/${p}` || pathname.startsWith(`/${p}/`)
    || Boolean(orgSlug && projectSlug && pathname.startsWith(`/${orgSlug}/${projectSlug}/${p}`));
  return [resource, ...extra].some(isActivePath);
}

// story #4885 (B 셸) — 자기 «목록 칸»을 가진 화면. 이 화면에서는 셸의 목록 칸(왼쪽 길잡이)이 접히고 화면의 목록(대화방 목록)이 그 자리를 쓴다 —
// 맥 창 1100에서 막대 56 + 방 목록 224 + 방 본문 + 스레드 300이 한 줄에 공존하려면 길잡이 256이 비어야 한다(댄군 UI-4 AC3 · PO 확정).
// 화면이 늘면 여기 한 줄만 더한다(셸은 이 목록만 읽는다).
// 경로는 목적지 모듈(nav-v3-destinations)의 «대화» 정본을 그대로 쓴다 — 목적지 문자열은 한 곳에서만 조립한다(verify:nav-v3-single-source).
export const SCREENS_OWNING_LIST_COLUMN: readonly string[] = [resolveChatsHref(undefined)];

export function screenOwnsListColumn(pathname: string): boolean {
  return SCREENS_OWNING_LIST_COLUMN.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}
