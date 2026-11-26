// story 5031 (C1) — the four places of the new shell: 홈 · 채팅 · 에이전트 · 설정, in that order. The web icon bar, the desktop app window and the phone's tab bar read the same four.
// This file is only the four (names · first screen · shortcut) and the function that says «which of the four am I in» for a path. Where every screen lives is nav-placement.ts; what the nav catalog
// holds (⌘K · «all screens») stays nav-config.ts — nothing is deleted, the shell just stops listing all of it at once.
import { DEPTH1_ITEMS, ROUTE_PLACEMENT, type Depth1Id, type Depth1Item, type PlacementSlot } from './nav-placement';

export { DEPTH1_IDS, DEPTH1_ITEMS } from './nav-placement';
export type { Depth1Id, Depth1Item } from './nav-placement';

export function depth1ByShortcut(key: string): Depth1Item | undefined {
  return DEPTH1_ITEMS.find((item) => item.shortcut === key);
}

// `[x]` segments of a page route match any one path segment. Rows are tried most specific first (more literal segments win; on a tie the longer route wins).
const MATCHERS = Object.keys(ROUTE_PLACEMENT)
  .filter((route) => route !== '/')
  .map((route) => ({
    route,
    re: new RegExp(`^${route.split('/').map((seg) => (/^\[.+\]$/.test(seg) ? '[^/]+' : seg.replace(/[.*+?^${}()|\\]/g, '\\$&'))).join('/')}/?$`),
    literals: route.split('/').filter((seg) => seg && !/^\[.+\]$/.test(seg)).length,
  }))
  .sort((a, b) => b.literals - a.literals || b.route.length - a.route.length);

/** The place a pathname belongs to (`outside` for login / public / flow pages; `undefined` when no screen matches). `?query` and `#hash` are ignored. */
export function placementSlotForPath(pathname: string): PlacementSlot | undefined {
  const path = pathname.split(/[?#]/)[0] || '/';
  if (path === '/') return ROUTE_PLACEMENT['/']?.slot;
  const hit = MATCHERS.find((m) => m.re.test(path));
  return hit ? ROUTE_PLACEMENT[hit.route]!.slot : undefined;
}

/** Which of the four is lit for a pathname: the place it belongs to; a page of the shell that is `outside`, or an unknown one, lights nothing. */
export function depth1ForPath(pathname: string): Depth1Id | undefined {
  const slot = placementSlotForPath(pathname);
  return slot && slot !== 'outside' ? slot : undefined;
}

/** The nav-catalog route key of an item — the same key the placement table is written in. */
export function navItemRoute(item: { kind: string; path: string }): string {
  const path = item.path.split('?')[0]!;
  return item.kind === 'resource' ? `/[ws]/[proj]/${path}` : path;
}

/**
 * The rows the list column draws for one of the four places: the catalog items whose placement row says this place AND carries the `depth1` door, first screen first, the rest in catalog order.
 * Everything else a place holds is reached through ⌘K, a card, an opened panel or its own page (nav-placement.json says how); nothing is deleted.
 */
export function listItemsForSlot<T extends { kind: string; path: string }>(items: readonly T[], slot: Depth1Id): T[] {
  const first = DEPTH1_ITEMS.find((d) => d.id === slot)?.path;
  const rows = items.filter((item) => {
    const row = ROUTE_PLACEMENT[navItemRoute(item)];
    return row?.slot === slot && row.doors.includes('depth1');
  });
  return [...rows.filter((r) => r.path === first), ...rows.filter((r) => r.path !== first)];
}
