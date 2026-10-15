// story #4490 — whose browser values these are. A sign-out, an account switch and adding an account clear the account's keys
// (story #4487), but a user can change without passing through any of them: the session expires, the server redirects to
// /login, an expired account is picked in the switcher, adding an account fails with 401, or the next person simply signs in
// on this browser after the last one's session ran out. So the signed-in screens (the session layouts · onboarding — the
// five places, PO 05:00Z) check the owner on their first render and clear the previous person's values before anything
// below them reads storage (claimTabOwner, run by TabOwnerGate).
//
// The owner is the session's `user_id` (users.id in both the JWT and the Firebase session branch — never a per-org member
// id). It is kept per store: localStorage is shared by the browser's tabs, sessionStorage belongs to one tab — a tab still
// holding the previous person's session values is checked on its own.
//
// Drafts (chat · field) carry the owner in their key (`…:u:<owner>:…`): a switch keeps them for when that person comes back,
// and nobody else on this browser sees them (PO 05:00Z ⑤).
import { clearAccountScopedStorage, type ClearMoment, type StorageArea } from './browser-storage-keys';

export const TAB_OWNER_KEY = 'sprintable_tab_owner';
/** Left by «add an account» just before it goes to /login: the next owner change on this browser is an intended switch. */
export const OWNER_HANDOFF_KEY = 'sprintable_owner_handoff';
/** PO 05:03Z — a mark left by an add that was never finished must not make a later stranger's sign-in a «switch». */
export const OWNER_HANDOFF_TTL_MS = 10 * 60_000;

/** Draft key prefixes (the head before the owner segment) and the store each lives in. */
const DRAFT_HEADS: ReadonlyArray<{ head: string; area: StorageArea }> = [
  { head: 'sprintable:chat-draft:', area: 'local' },
  { head: 'sprintable:field-draft:v1:', area: 'session' },
];
const OWNER_SEGMENT = 'u:';

function store(area: StorageArea): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return area === 'session' ? window.sessionStorage : window.localStorage;
  } catch {
    return null; // storage blocked (a private window)
  }
}

function get(area: StorageArea, key: string): string | null {
  try { return store(area)?.getItem(key) ?? null; } catch { return null; }
}

function put(area: StorageArea, key: string, value: string | null): void {
  const s = store(area);
  if (!s) return;
  try {
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
  } catch { /* best effort */ }
}

/** The owner segment a draft key starts with in this store — `u:<owner>:` (`u:-:` before any owner is known). */
export function draftOwnerSegment(area: StorageArea): string {
  return `${OWNER_SEGMENT}${get(area, TAB_OWNER_KEY) ?? '-'}:`;
}

/** Drafts written before story #4490 carry no owner: give them to `owner` (a draft must never just vanish — PO 05:00Z ⑤). */
function adoptOwnerlessDrafts(area: StorageArea, owner: string): void {
  const s = store(area);
  if (!s) return;
  try {
    const moves: Array<[string, string]> = [];
    for (let i = 0; i < s.length; i += 1) {
      const k = s.key(i);
      if (k === null) continue;
      for (const d of DRAFT_HEADS) {
        if (d.area === area && k.startsWith(d.head) && !k.startsWith(d.head + OWNER_SEGMENT)) {
          moves.push([k, `${d.head}${OWNER_SEGMENT}${owner}:${k.slice(d.head.length)}`]);
        }
      }
    }
    for (const [from, to] of moves) {
      const v = s.getItem(from);
      if (v !== null && s.getItem(to) === null) s.setItem(to, v);
      s.removeItem(from);
    }
  } catch { /* best effort */ }
}

function intendedSwitch(now: number): boolean {
  const raw = get('local', OWNER_HANDOFF_KEY);
  put('local', OWNER_HANDOFF_KEY, null); // read once, then gone (PO 05:03Z ①)
  const at = raw === null ? NaN : Number(raw);
  return Number.isFinite(at) && now - at >= 0 && now - at <= OWNER_HANDOFF_TTL_MS;
}

/**
 * Called on the first render of a signed-in screen, before anything below it reads storage. For each store: a different owner
 * than `userId` → clear the account's keys (an intended switch or add → `switch`, drafts stay under their owner; any other way
 * → `signout`, drafts too — that person may not come back), then this user owns it. Drafts with no owner are adopted first
 * (by the previous owner when known). Never throws.
 */
export function claimTabOwner(userId: string, now = Date.now()): void {
  if (typeof window === 'undefined' || !userId) return;
  let switching: boolean | null = null; // read the handoff mark only when an owner actually changes
  for (const area of ['local', 'session'] as const) {
    const owner = get(area, TAB_OWNER_KEY);
    adoptOwnerlessDrafts(area, owner ?? userId);
    if (owner !== null && owner !== userId) {
      if (switching === null) switching = intendedSwitch(now);
      const moment: ClearMoment = switching ? 'switch' : 'signout';
      clearAccountScopedStorage(moment, [area]);
    }
    if (owner !== userId) put(area, TAB_OWNER_KEY, userId);
  }
}

/** An account switch: the account's values were just cleared as a `switch`; the next owner is known — write it now. */
export function handOwnerTo(nextUserId: string): void {
  if (!nextUserId) return;
  put('local', TAB_OWNER_KEY, nextUserId);
  put('session', TAB_OWNER_KEY, nextUserId);
}

/** Adding an account: the next user is known only after they sign in — mark the coming owner change as intended. */
export function markIntendedSwitch(now = Date.now()): void {
  put('local', OWNER_HANDOFF_KEY, String(now));
}
