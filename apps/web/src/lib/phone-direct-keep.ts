// story 4993 (PO ⓐ, 11-23) — keep the same-network direct road ALIVE while a screen of that computer is in front.
//
// Before: the road was made behind the FIRST press and ended at the phone's 60 s idle, so presses a few minutes apart nearly all went by the server (the wheel's lap 22 · 23: the second press 26 s after the first rode the road, one 78 s after it did not).
// Design ③ v4 (§2-1 · §3-1) says the phone asks for a road «while its screen is open» and the 60 s is a DoS line, not a battery or socket one; the Mac's life of 10 minutes and its rate (per phone 6 a minute · 30 an hour) are untouched. So:
//   · a screen of that computer comes to the front → ask the shell where the road is (`direct.keep`, which on a READY road sends one `ping`: «still here»); `idle` → the road is opened (the same «started lately» note as a press: never two at once)
//   · every DIRECT_KEEP_EVERY_MS (30 s — the shell's idle is 60 s) while the screen stays in front, the same call: a ping on a ready road, and when the road ended (its life of 10 minutes · a network change) the next call finds it `idle` and makes it again → at most ONE road per 10 minutes
//     (6 an hour, inside the Mac's 30) — never a renegotiation per idle end
//   · the screen goes hidden, or the last screen of that computer leaves → after DIRECT_KEEP_GRACE_MS (a quick return costs nothing) the road is closed (`direct.close` — a normal end); coming back opens it again
//   · a shell that does not say `direct_keep: 1` is asked `direct.status` instead (the road is made at the screen, it just ends at its idle, as before); a shell that does not say `direct: 1`, or a page outside the phone app: nothing at all.
// This asks the shell and nothing else: no press, no command, no address — the answers are words (the contract's `direct.keep` reply: {state}).
import { callWithin, notRefused, openFired as sharedOpenFired, openIfNotLately, type DirectDeps } from './phone-direct';
import type { PhoneAnswer } from './phone-bridge';

type Call = (type: string, args: Record<string, unknown>) => Promise<PhoneAnswer>;

/** how often a screen in front says «still here» — well inside the shell's idle of 60 s (a missed tick or two costs nothing) */
export const DIRECT_KEEP_EVERY_MS = 30_000;
/** a screen that went hidden (or the last screen of the computer that left) keeps the road this long before it is closed: leaving and coming straight back is free */
export const DIRECT_KEEP_GRACE_MS = 10_000;
/** one local call of the shell (`shell.caps` · `direct.keep` · `direct.status` · `direct.close`) is «no answer» after this */
export const DIRECT_KEEP_CALL_MS = 5_000;
/** a road the keeper made that is still not there at the next look (the Mac refused · the network cannot) is not made again at once: the wait between two makings of one computer doubles from a minute up to ten (one making per 10 minutes is the road's own life), and a road that came back to being resets it */
export const DIRECT_KEEP_BACKOFF_MIN_MS = 60_000;
export const DIRECT_KEEP_BACKOFF_MAX_MS = 600_000;
/** the keepers of the whole page make at most this many roads in an hour, whatever the computers or the failures (the Mac allows 30 an hour per phone; a press makes its own beside these) */
export const DIRECT_KEEP_OPENS_PER_HOUR = 12;
/** … and at most this many in any minute (the Mac allows 6 a minute per phone: several computers coming to the front together must not spend them all — a press makes its own beside these) */
export const DIRECT_KEEP_OPENS_PER_MINUTE = 3;

export interface KeepEnv {
  phoneCall: Call;
  /** the page is in front (a hidden tab · a backgrounded app is not) */
  visible: () => boolean;
  /** tells when `visible()` may have changed; returns the way to stop listening */
  onVisibility: (cb: () => void) => () => void;
  /** a one-shot timer; returns the way to cancel it */
  timer: (fn: () => void, ms: number) => () => void;
  /** the same as a press's: fetch · wait · negotiate limits · the note of the last road start (default: the one every press shares) */
  deps?: Partial<DirectDeps>;
}

type Mode = 'unknown' | 'keep' | 'status' | 'none';
interface Keeper { setupId: string; env: KeepEnv; count: number; mode: Mode; /** `status` mode only: the road was made once since the screen came to the front */ statusOpened: boolean; busy: boolean; /** a look was wanted while one was running: it is made as soon as that one ends */ again: boolean; /** the keeper made a road at its last making and has not yet seen it there */ attempted: boolean; lastOpenAt: number; openGap: number; cancelTick: (() => void) | null; cancelGrace: (() => void) | null; stopVis: (() => void) | null; ended: boolean }
const keepers = new Map<string, Keeper>();
/** a `direct.close` that is on its way, by computer — page-wide, so a keeper made after the last one went (a screen that comes straight back) waits for it too */
const closing = new Map<string, Promise<void>>();
/** when the keepers made a road, page-wide (the last hour) */
const opens: number[] = [];

const wanted = (k: Keeper): boolean => k.count > 0 && k.env.visible();
const openDeps = (k: Keeper): DirectDeps => ({ phoneCall: k.env.phoneCall, openFired: sharedOpenFired, ...(k.env.deps ?? {}) });

/** what `shell.caps` says: `direct: 1` and `direct_keep: 1` → keep · `direct: 1` alone → status · anything else that IS an answer → none · a transient refusal → unknown (asked again) */
function modeOf(caps: PhoneAnswer): Mode {
  if (caps.ok === false) return caps.code === 'bad_request' ? 'none' : 'unknown'; // (a shell that does not know the question says `bad_request`: no road to keep. Any other refusal — `page_hidden` as the screen goes · a bridge that failed — is not an answer about the shell: asked again at the next look)
  if (caps.ok !== true || !caps.caps || typeof caps.caps !== 'object') return 'none';
  const c = caps.caps as { direct?: unknown; direct_keep?: unknown };
  return c.direct === 1 ? (c.direct_keep === 1 ? 'keep' : 'status') : 'none';
}

/** one look: where the road is — and make it when it is `idle` */
/** one look (the body of a tick): where the road is — and make it when it is `idle` */
async function look(k: Keeper): Promise<void> {
  const pending = closing.get(k.setupId); if (pending) await pending; // (a close that is still on its way ends first — whichever keeper sent it: the road a look makes after it is the one that stays)
  if (k.mode === 'unknown') { const caps = await callWithin(k.env.phoneCall, 'shell.caps', {}, DIRECT_KEEP_CALL_MS); if (!caps) return; k.mode = modeOf(caps); if (k.mode === 'unknown') return; } // (no answer · a transient refusal: nothing more this look; asked again next time) // (no answer: asked again next time)
  if (k.mode === 'none' || !wanted(k)) return;
  const ans = await callWithin(k.env.phoneCall, k.mode === 'keep' ? 'direct.keep' : 'direct.status', { setup_id: k.setupId }, DIRECT_KEEP_CALL_MS);
  if (!notRefused(ans) || !wanted(k)) return; // (a refusal · no answer · a screen that went while we waited: nothing)
  if (ans.state === 'ready') { k.attempted = false; k.openGap = 0; return; } // (pinged by the call itself; the road is there: the last making worked)
  if (ans.state !== 'idle') return; // (asking · connecting · proving: being made — not asked again, and not yet counted as a road that came: it may still fail)
  if (k.attempted) { k.attempted = false; k.openGap = Math.min(Math.max(k.openGap * 2, DIRECT_KEEP_BACKOFF_MIN_MS), DIRECT_KEEP_BACKOFF_MAX_MS); } // (the last making left no road: wait longer before the next)
  // a shell that cannot keep a road alive (no `direct_keep`) loses it at its 60 s idle: made again at EVERY idle end that would be one road a minute — over the Mac's 30 an hour. It is made once per coming to the front; the next press makes it again behind itself, as before.
  if (k.mode === 'status' && k.statusOpened) return;
  const at = Date.now();
  if (at - k.lastOpenAt < k.openGap) return;
  while (opens.length > 0 && at - opens[0]! >= 3_600_000) opens.shift();
  if (opens.length >= DIRECT_KEEP_OPENS_PER_HOUR) return; // (the page's own bound: no more roads from keepers this hour)
  if (opens.filter((t) => at - t < 60_000).length >= DIRECT_KEEP_OPENS_PER_MINUTE) return; // (… nor more than a few in one minute, whatever the computers)
  if (k.mode === 'status') k.statusOpened = true;
  opens.push(at); k.lastOpenAt = at; k.attempted = true;
  openIfNotLately(openDeps(k), k.setupId);
}

/** a tick: one look at a time; a screen that came back while one was running is looked at once more as soon as it ends (not 30 s later) */
async function tick(k: Keeper): Promise<void> {
  if (k.busy || k.ended) return;
  k.busy = true;
  try { await look(k); } catch { /* a look that fails is nobody's business: the next one asks again */ } finally { k.busy = false; }
  if (k.again) { k.again = false; if (wanted(k)) await tick(k); }
}

function schedule(k: Keeper): void {
  if (k.cancelTick || k.ended || !wanted(k)) return;
  k.cancelTick = k.env.timer(() => { k.cancelTick = null; void tick(k).then(() => schedule(k)); }, DIRECT_KEEP_EVERY_MS);
}
function stopLoop(k: Keeper): void { if (k.cancelTick) { k.cancelTick(); k.cancelTick = null; } }

async function closeRoad(k: Keeper): Promise<void> {
  if (k.mode !== 'keep' && k.mode !== 'status') return; // (a shell that does not say `direct: 1` — or never answered `shell.caps` — has no road of ours to close)
  k.attempted = false; k.openGap = 0; // (a road we end ourselves is not a making that failed)
  const deps = openDeps(k);
  deps.openFired?.delete(k.setupId); // (a press right after the close may make the road again at once)
  const p = callWithin(k.env.phoneCall, 'direct.close', { setup_id: k.setupId }, DIRECT_KEEP_CALL_MS).then(() => undefined, () => undefined).finally(() => { if (closing.get(k.setupId) === p) closing.delete(k.setupId); });
  closing.set(k.setupId, p); await p;
}

/** the screen is not in front (hidden · no screen of that computer left): the loop stops; after the grace the road is closed, and with no screen left the keeper is gone */
function leave(k: Keeper): void {
  stopLoop(k); k.statusOpened = false; // (back after being away, a road may be made once more)
  if (k.cancelGrace || k.ended) return;
  k.cancelGrace = k.env.timer(() => {
    k.cancelGrace = null;
    if (wanted(k)) return;
    void closeRoad(k);
    if (k.count === 0) { k.ended = true; if (k.stopVis) { k.stopVis(); k.stopVis = null; } if (keepers.get(k.setupId) === k) keepers.delete(k.setupId); }
  }, DIRECT_KEEP_GRACE_MS);
}
function comeBack(k: Keeper, lookNow: boolean): void {
  if (k.cancelGrace) { k.cancelGrace(); k.cancelGrace = null; }
  if (k.busy) { if (lookNow) k.again = true; schedule(k); return; } // (a screen came back while a look is running: another follows it at once — a second screen of the same computer does not need one)
  if (lookNow && !k.cancelTick) void tick(k).then(() => schedule(k)); else schedule(k);
}

/**
 * A screen of this computer is in front: hold the road. Many screens may hold the same computer (one keeper, a count); the returned function lets go (once). The caller decides that it is the phone app, and that the shell is the one for this computer.
 */
export function holdDirectRoad(setupId: string, env: KeepEnv): () => void {
  let k = keepers.get(setupId);
  const fresh = !k;
  if (!k) {
    k = { setupId, env, count: 0, mode: 'unknown', statusOpened: false, busy: false, again: false, attempted: false, lastOpenAt: -Infinity, openGap: 0, cancelTick: null, cancelGrace: null, stopVis: null, ended: false };
    keepers.set(setupId, k);
    const mine = k;
    k.stopVis = env.onVisibility(() => { if (mine.ended) return; if (wanted(mine)) comeBack(mine, true); else leave(mine); });
  }
  k.count += 1;
  if (wanted(k)) comeBack(k, fresh || (!k.cancelTick && !k.busy)); else leave(k); // (a screen that comes straight back inside the grace looks at once: the loop was stopped when the last one left)
  const keeper = k; let released = false;
  return () => {
    if (released) return; released = true;
    keeper.count -= 1;
    if (keeper.count === 0) leave(keeper);
  };
}

/** tests only: forget every keeper (their timers are the test's own) */
export function __resetDirectKeepForTest(): void { for (const k of keepers.values()) { k.ended = true; stopLoop(k); if (k.cancelGrace) { k.cancelGrace(); k.cancelGrace = null; } if (k.stopVis) k.stopVis(); } keepers.clear(); closing.clear(); opens.length = 0; sharedOpenFired.clear(); }
