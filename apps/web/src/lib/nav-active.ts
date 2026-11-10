// story #4885 (UI-2) — «지금 여기» 판정의 한 곳. 어떤 셸(왼쪽 길잡이 · 아이콘 막대 · 위쪽 탭)이 그려도 같은 규칙을 쓴다: 그리는 쪽이 바뀌어도 판정은 한 벌.
//  · 정적 항목: 경로(쿼리 뗀)가 지금 주소와 같거나 그 하위이고, 항목 경로가 쿼리(`?tab=gates`)를 가지면 지금 주소의 같은 키가 같은 값일 때만 맞다. 맞는 항목이 여럿이면 **가장 구체적인 하나**(경로 가장 긴 · 쿼리 있는)만 켠다.
//  · 자원(`/{ws}/{proj}/{자원}`) 항목: 직접 경로 또는 flat 경로가 지금 주소와 같거나 그 하위. 일감처럼 탭줄을 가진 항목은 탭 경로들(extra)까지 본다.
import type { NavItemConfig } from './nav-config';

export function findActiveStaticItemId(items: ReadonlyArray<Pick<NavItemConfig, 'id' | 'kind' | 'path'>>, pathname: string, search: URLSearchParams): string | null {
  let best: { id: string; weight: number } | null = null;
  for (const item of items) {
    if (item.kind !== 'static') continue;
    const [route, query = ''] = item.path.split('?') as [string, string | undefined];
    if (!(pathname === route || (route !== '/' && pathname.startsWith(`${route}/`)))) continue;
    const wanted = new URLSearchParams(query);
    if ([...wanted].some(([key, value]) => search.get(key) !== value)) continue;
    const weight = route.length * 2 + (query ? 1 : 0);
    if (!best || weight > best.weight) best = { id: item.id, weight };
  }
  return best?.id ?? null;
}

export function isResourceItemActive(pathname: string, resource: string, orgSlug: string | undefined, projectSlug: string | undefined, extra: readonly string[] = []): boolean {
  const isActivePath = (p: string) => pathname === `/${p}` || pathname.startsWith(`/${p}/`)
    || Boolean(orgSlug && projectSlug && pathname.startsWith(`/${orgSlug}/${projectSlug}/${p}`));
  return [resource, ...extra].some(isActivePath);
}
