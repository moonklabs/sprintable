// story 5031 (C1) — the one table that says where every screen of the web app lives in the new four-place shell (홈 · 채팅 · 에이전트 · 설정) and how a person gets there.
// Nothing here moves or deletes a route: it is the «빠짐 0» ground. nav-placement.test.ts reads the folder `app/` and fails when a page.tsx has no row, when a row has no page, when a slot is not one of the four
// (or «outside»), or when a claimed door does not exist. The rows are plain data (nav-placement.json) on purpose: route strings written in .ts files are counted by the flat-link and pairing-entry ratchets.
//
// slot   : the one of the four places the screen belongs to · `outside` = login / public / app-flow / internal / switched-off pages that are not part of the shell
// doors  : depth1 = a row in the list column of its slot (nav catalog item) · cmdk = a row in the ⌘K palette · in-page = opened from the page named in `from` · flow = a step of a login / pairing / app flow ·
//          redirect = only forwards elsewhere · none = deliberately no door (the reason is the row's `why`)
// The ⌘K palette and the list column read the nav catalog (nav-config.ts), not this table; the test checks that the two agree.
import table from './nav-placement.json';

export const DEPTH1_IDS = ['home', 'chat', 'agents', 'settings'] as const;
export type Depth1Id = (typeof DEPTH1_IDS)[number];

export type PlacementSlot = Depth1Id | 'outside';
export type PlacementDoor = 'depth1' | 'cmdk' | 'in-page' | 'flow' | 'redirect' | 'none';
export interface RoutePlacement {
  slot: PlacementSlot;
  doors: readonly PlacementDoor[];
  /** one line: why it sits here (the audit trail of the placement — shown nowhere in the UI) */
  why: string;
  /** for `in-page`: the page it is opened from (must itself be a row of this table) */
  from?: string;
}

export interface Depth1Item {
  id: Depth1Id;
  /** `nav.*` message key (ko 홈 · 채팅 · 에이전트 · 설정) */
  labelKey: string;
  /** the first screen of the place (a static, workspace-less path) */
  path: string;
  /** ⌘1~⌘4 (⌃ on Windows / Linux) */
  shortcut: '1' | '2' | '3' | '4';
  /** the badge this place carries (the numbers are fed by the shell, not counted here) */
  badge?: 'needs-hand' | 'unread';
}

export const ROUTE_PLACEMENT = table.routes as unknown as Readonly<Record<string, RoutePlacement>>;
// the names are message keys written out as literals (the dead-key guard reads `labelKey: '…'`); the first screens · shortcuts · badges are plain data
const DEPTH1_LABEL_KEYS: ReadonlyArray<{ id: Depth1Id; labelKey: string }> = [
  { id: 'home', labelKey: 'zoneNow' },
  { id: 'chat', labelKey: 'depth1Chat' },
  { id: 'agents', labelKey: 'workforce' },
  { id: 'settings', labelKey: 'settings' },
];
export const DEPTH1_ITEMS: readonly Depth1Item[] = (table.depth1 as unknown as Array<Omit<Depth1Item, 'labelKey'>>).map((item) => ({ ...item, labelKey: DEPTH1_LABEL_KEYS.find((l) => l.id === item.id)!.labelKey }));
