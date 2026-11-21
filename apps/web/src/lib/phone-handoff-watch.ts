// story 4978 (C1b-phone) — how long and how often the phone looks for handoffs computers put for it. A computer puts one the moment ITS person presses [같아요] (right after this phone's own press) and again, a new envelope, when one ran out unread; so the look
// is made often for a while after a pairing and once when the app opens (and comes back to the front) — never on a timer for ever. One watch at a time: asking again only EXTENDS the window.
import { takeHandoffs, type TakeCache } from './phone-handoff';
import type { PhoneAnswer } from './phone-bridge';

type Call = (type: string, args?: Record<string, unknown>) => Promise<PhoneAnswer>;

export const WATCH_EVERY_MS = 5_000;
/** after the first two minutes of a watch (the computer's first put comes within moments of its person's press) the look is made less often */
export const WATCH_SLOW_AFTER_MS = 120_000;
export const WATCH_SLOW_EVERY_MS = 15_000;
/** after this phone's own pairing: a computer's first handoff comes within moments, a resend within the 15 minutes a row lives */
export const AFTER_PAIRING_MS = 10 * 60_000;
/** when the app opens or comes back to the front: one look now and a short burst (a computer that sealed a new envelope while the app was away) */
export const ON_OPEN_MS = 60_000;

export interface WatchEnv { now: () => number; setTimer: (fn: () => void, ms: number) => unknown; clearTimer: (h: unknown) => void }
const realEnv: WatchEnv = { now: () => Date.now(), setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

let until = 0;
let timer: unknown = null;
let looking = false;
let current: { phoneCall: Call; env: WatchEnv; cache: TakeCache; startedAt: number } | null = null;
let stopped = false;
/** one number per run of the watch: a look that was in flight when the watch was stopped and started again finishes into the OLD run and changes nothing of the new one */
let run = 0;

async function tick(): Promise<void> {
  timer = null;
  const c = current;
  const mine = run;
  if (!c || stopped) return;
  if (c.env.now() >= until) { current = null; return; }
  if (!looking) {
    looking = true;
    let out;
    try { out = await takeHandoffs({ phoneCall: c.phoneCall, cache: c.cache }); } catch { out = { kind: 'failed' } as const; } finally { if (run === mine) looking = false; }
    if (run !== mine) return; // the watch was stopped (and maybe started again) while the look was out: this look belongs to a run that is over
    // a shell that does not do it · no phone · a sign-out: nothing will change by asking again — the watch ends (the next pairing or opening starts one)
    if (out.kind === 'unsupported' || out.kind === 'no_phone' || out.kind === 'signed_out') { current = null; until = 0; return; }
  }
  const every = c.env.now() - c.startedAt >= WATCH_SLOW_AFTER_MS ? WATCH_SLOW_EVERY_MS : WATCH_EVERY_MS;
  if (current && !stopped && run === mine && c.env.now() < until && timer === null) timer = c.env.setTimer(() => { void tick(); }, every);
}

/** look now, and again every WATCH_EVERY_MS for `forMs` (a watch that is already running is only extended, never doubled) */
export function startHandoffWatch(o: { phoneCall: Call; forMs: number; env?: WatchEnv }): void {
  const env = o.env ?? realEnv;
  stopped = false;
  until = Math.max(until, env.now() + o.forMs);
  const wasRunning = current !== null;
  current = wasRunning && current ? { ...current, phoneCall: o.phoneCall, env } : { phoneCall: o.phoneCall, env, cache: {}, startedAt: env.now() };
  if (!wasRunning) { run += 1; void tick(); }
}

/** the page is going away or the person signed out: no more looks */
export function stopHandoffWatch(): void {
  stopped = true; until = 0; run += 1; looking = false;
  if (timer !== null && current) current.env.clearTimer(timer);
  timer = null; current = null;
}

/** tests only */
export function __handoffWatchForTest(): { running: boolean; until: number } { return { running: current !== null, until }; }
