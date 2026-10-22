// story #4733 (S4b · design dan/4733-phone-clock-design-1020.md §7 · §9 · copy yuna/4733-phone-clock-copy-1020.md): from inside the phone app, end and start the
// sessions of a paired computer — all of them, or one agent's — through the computer's own flow (the daemon decides; the server only carries the press).
//
// The web only says which computer, which action and — for one agent — which agent. The phone app's shell reads the server's list itself, checks the pick is in it,
// asks the person on the OS prompt and signs exactly seven keys (kind 'clock'); the web then posts the shell's `signed` and follows the command to its end.
// «Not known» is never said as «not done» (the same rule as phone-start.ts and phone-command.ts): once the post may have reached the server, an end the web cannot see
// is `unknown` — [결과 확인] / the next look follows THAT command (same key, same signed body, no new signature). Only a command that was NEVER taken by the computer
// within its life (still `queued` at the end) is said to have stopped nothing: `expired`.

import { fetchWithAuth } from '@/lib/db/client';
import { DESKTOP_CLOCK_ACTIONS } from '@/lib/desktop-clock-keys';
import type { PhoneAnswer } from './phone-bridge';
import type { Flow } from './phone-start';

export type ClockAction = (typeof DESKTOP_CLOCK_ACTIONS)[number];

/** the words a finished clock command ends in (the daemon's; the server refuses any other) — the nine of a press and, S5 · P2, the two more of an edit */
export const CLOCK_RESULTS = ['ok', 'already', 'nothing_running', 'not_open', 'not_ready', 'needs_hands', 'not_clocked_out', 'unknown_agent', 'already_running', 'stale', 'not_editable'] as const;
export type ClockResult = (typeof CLOCK_RESULTS)[number];

// ── the computer's closed view (GET …/clock) — kept only as far as the screen draws it; anything not ours is dropped ─────────────────────────────────────────────
export const ROW_STATES = ['drafting', 'ready', 'needs_you', 'saving', 'saved', 'ended', 'not_ended', 'failed'] as const;
export type RowState = (typeof ROW_STATES)[number];
export interface ClockRowView {
  agentId: string; name: string | null; state: RowState; missing: Array<'done' | 'plan' | 'blockers'>; firstLine: string | null; idle: boolean;
  /** S5 · P2: the row's revision (an edit names the one it read — the computer refuses it when the row has moved) · a person's hand has been on the row: its line is the person's own words */
  rev: number; edited: boolean;
}
export interface ClockOutView { at: string; came: number; warn: 'none' | 'many' | 'full'; stillWorking: string[]; left: string[]; alone: number }
export interface ClockInView { at: string | null; starting: { k: number; n: number } | null; handing: { k: number; m: number } | null; came: { total: number } | null; failed: Array<{ name: string; code: string; limit: number | null }>; unread: string[] }
export interface ClockOneView { agentId: string; name: string | null; at: string }
export interface ClockView {
  mode: 'none' | 'panel' | 'out' | 'in';
  scope: 'computer' | 'one' | null;
  openedFrom: 'mac' | 'phone' | null;
  count: { ready: number; needsYou: number; drafting: number } | null;
  rows: ClockRowView[];
  out: ClockOutView | null;
  in: ClockInView | null;
  outs: ClockOneView[];
  reportedAt: string | null;
}
/** what the screen needs of one computer: `supported` = the computer's app speaks `clock` at all (an older one → no buttons, no line) */
export interface ClockRead { remoteControl: boolean; reachable: boolean; supported: boolean; view: ClockView | null }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
/** the server's names and an agent's draft line are text from outside: direction overrides and isolates (U+202A–202E · U+2066–2069) and the plain direction marks (U+200E · U+200F · U+061C) are taken out before they are drawn — a line must not be able to reorder what stands beside it */
const BIDI = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/g;
export const plain = (v: string): string => v.replace(BIDI, '');
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map(plain) : []);

export function parseClockRead(raw: unknown): ClockRead | null {
  if (!isObj(raw) || typeof raw.remote_control !== 'boolean' || typeof raw.reachable !== 'boolean' || typeof raw.supported !== 'boolean') return null;
  const base = { remoteControl: raw.remote_control, reachable: raw.reachable, supported: raw.supported };
  if (raw.view === null || raw.view === undefined) return { ...base, view: null };
  const v = raw.view;
  if (!isObj(v) || !(v.mode === 'none' || v.mode === 'panel' || v.mode === 'out' || v.mode === 'in')) return null; // a mode this page does not know: not a view it can draw
  // a panel is the whole computer's or one agent's: one that does not say which is not a view this page can act on (it would otherwise press for the whole computer)
  if (v.mode === 'panel' && v.scope !== 'computer' && v.scope !== 'one') return null;
  // …and one agent's panel is exactly one row (a cancel / submit for "the row" must have a row to name)
  if (v.mode === 'panel' && v.scope === 'one' && !(Array.isArray(v.rows) && v.rows.length === 1)) return null;
  // …and the card after (`out`) / the start (`in`) must carry what it is about: without it the page would fall back to the idle card's buttons for a state it cannot read
  if (v.mode === 'out' && !(isObj(v.out) && isStr(v.out.at))) return null;
  if (v.mode === 'in' && !isObj(v.in)) return null;
  const rows: ClockRowView[] = [];
  for (const r of Array.isArray(v.rows) ? v.rows : []) {
    // a row this page cannot read makes the whole view unreadable — never a view with fewer rows than the computer sent (the counts and the consent would then be about rows the person
    // is not looking at)
    if (!isObj(r) || !isStr(r.agent_member_id) || !(ROW_STATES as readonly unknown[]).includes(r.state)) return null;
    rows.push({
      agentId: r.agent_member_id,
      name: isStr(r.name) ? plain(r.name) : null,
      state: r.state as RowState,
      missing: (Array.isArray(r.missing) ? r.missing : []).filter((m): m is 'done' | 'plan' | 'blockers' => m === 'done' || m === 'plan' || m === 'blockers'),
      firstLine: isStr(r.first_line) ? (plain(r.first_line).trim() === '' ? null : plain(r.first_line)) : null, // plain text only — drawn as characters (never a link, never HTML)
      idle: r.idle === true,
      rev: typeof r.rev === 'number' && Number.isSafeInteger(r.rev) && r.rev >= 0 ? r.rev : 0, // (an older computer sends none: 0)
      edited: r.edited === true,
    });
  }
  let out: ClockOutView | null = null;
  if (isObj(v.out) && isStr(v.out.at)) {
    out = { at: v.out.at, came: num(v.out.came) ?? 0, warn: v.out.warn === 'many' || v.out.warn === 'full' ? v.out.warn : 'none', stillWorking: strs(v.out.still_working), left: strs(v.out.left), alone: num(v.out.alone) ?? 0 };
  }
  let inn: ClockInView | null = null;
  if (isObj(v.in)) {
    const i = v.in;
    inn = {
      at: isStr(i.at) ? i.at : null,
      starting: isObj(i.starting) && num(i.starting.k) !== null && num(i.starting.n) !== null ? { k: i.starting.k as number, n: i.starting.n as number } : null,
      handing: isObj(i.handing) && num(i.handing.k) !== null && num(i.handing.m) !== null ? { k: i.handing.k as number, m: i.handing.m as number } : null,
      came: isObj(i.came) && num(i.came.total) !== null ? { total: i.came.total as number } : null,
      failed: (Array.isArray(i.failed) ? i.failed : []).filter((f): f is Record<string, unknown> => isObj(f) && isStr(f.name) && isStr(f.code)).map((f) => ({ name: plain(f.name as string), code: f.code as string, limit: num(f.limit) })),
      unread: strs(i.unread),
    };
  }
  const count = isObj(v.count) && num(v.count.ready) !== null && num(v.count.needs_you) !== null && num(v.count.drafting) !== null
    ? { ready: v.count.ready as number, needsYou: v.count.needs_you as number, drafting: v.count.drafting as number } : null;
  const outs: ClockOneView[] = (Array.isArray(v.outs) ? v.outs : [])
    .filter((o): o is Record<string, unknown> => isObj(o) && isStr(o.agent_member_id) && isStr(o.at))
    .map((o) => ({ agentId: o.agent_member_id as string, name: isStr(o.name) ? plain(o.name) : null, at: o.at as string }));
  return {
    ...base,
    view: {
      mode: v.mode, scope: v.scope === 'computer' || v.scope === 'one' ? v.scope : null, openedFrom: v.opened_from === 'mac' || v.opened_from === 'phone' ? v.opened_from : null,
      count, rows, out, in: inn, outs, reportedAt: isStr(v.reported_at) ? v.reported_at : null,
    },
  };
}

export type ClockReadOutcome =
  | { kind: 'read'; read: ClockRead }
  | { kind: 'not_allowed' } // 403 — this person cannot command that computer (the card is not drawn)
  | { kind: 'not_paired' } // 409 phone_not_paired
  | { kind: 'failed' };

/** the computer's closed view, for THIS phone's key (the server answers only the person's own paired phone) */
export async function readClock(setupId: string, phoneKeyId: string, stop?: () => boolean): Promise<ClockReadOutcome> {
  if (stop?.()) return { kind: 'failed' };
  try {
    const res = await fetchWithAuth(`/api/desktop/setups/${encodeURIComponent(setupId)}/clock?phone_key_id=${encodeURIComponent(phoneKeyId)}`);
    if (stop?.()) return { kind: 'failed' };
    if (res.status === 403) return { kind: 'not_allowed' };
    if (res.status === 409) return (await codeOf(res)) === 'phone_not_paired' ? { kind: 'not_paired' } : { kind: 'failed' };
    if (!res.ok) return { kind: 'failed' };
    const read = parseClockRead(await res.json());
    return read ? { kind: 'read', read } : { kind: 'failed' };
  } catch {
    return { kind: 'failed' };
  }
}

// ── a press ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type PressOutcome =
  | { kind: 'done'; result: ClockResult } // the computer answered with one of its nine words
  | { kind: 'unreachable' } // 409 device_unreachable — certainly nothing was made
  | { kind: 'remote_off' }
  | { kind: 'not_paired' } // 409 phone_not_paired · the shell found no such computer on this phone's list
  | { kind: 'not_allowed' } // 403 — this person may not command that computer
  | { kind: 'expired' } // the computer never took it within its life (still queued at the end) — nothing was stopped
  | { kind: 'cancelled' } // the person said no on the OS prompt — not a failure, no line
  | { kind: 'biometric_required' }
  | { kind: 'no_screen_lock' }
  | { kind: 'key_invalidated' }
  | { kind: 'not_registered' }
  | { kind: 'signed_out' }
  | { kind: 'stopped' } // the flow was stopped (the screen left): nothing is drawn or moved for it
  | { kind: 'unknown'; pending: Pending } // it may have gone (the answer was lost · no end in the window) — follow it, never redo it
  | { kind: 'failed' };

export interface PressInput { setupId: string; action: ClockAction; agentId?: string }
/** a press the web posted (or tried to): what the next look follows again — the same key and body, its id once known */
export interface Pending { setupId: string; key: string; body: Record<string, unknown>; commandId?: string }

type Call = (type: string, args: Record<string, unknown>) => Promise<PhoneAnswer>;
export interface PressDeps {
  phoneCall: Call;
  /** the flow this press belongs to: every async step looks at ITS one `stopped` (phone-start's beginFlow) */
  flow?: Flow;
  /** a fresh idempotency key per press (the server keys the command on it) */
  newKey: () => string;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
  pollMs?: number;
  pollMaxMs?: number;
}

/** the command lives 120 s on the computer's side; the web follows it every 1.5 s a little past that, so «still queued» at the end really means «never taken» */
export const PRESS_POLL_MS = 1_500;
export const PRESS_POLL_MAX_MS = 125_000;
/** a look at the command that finds it STILL queued this long after the post is past the computer's 120 s: it was never taken and never will be */
export const COMMAND_LIFE_MS = 121_000;

// the shell's refusals → one outcome each (the codes are the shell's own: phoneCalls.js clockSign · the bridge's key refusals)
const SHELL_REFUSALS: Record<string, PressOutcome['kind']> = {
  cancelled: 'cancelled',
  biometric_required: 'biometric_required',
  no_screen_lock: 'no_screen_lock',
  key_invalidated: 'key_invalidated',
  not_registered: 'not_registered',
  signed_out: 'signed_out',
  remote_control_off: 'remote_off',
  computer_not_found: 'not_paired',
  device_unreachable: 'unreachable',
  not_allowed: 'not_allowed', // the shell found no agent of that computer the person may command (before any prompt)
};

async function codeOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { code?: string }; code?: string };
    return body.error?.code ?? body.code ?? '';
  } catch {
    return '';
  }
}

export async function pressClock(input: PressInput, deps: PressDeps): Promise<PressOutcome> {
  const args: Record<string, unknown> = { kind: 'clock', setup_id: input.setupId, action: input.action, ...(input.agentId !== undefined ? { agent_member_id: input.agentId } : {}) };
  let signed: PhoneAnswer;
  try {
    signed = await deps.phoneCall('command.sign', args);
  } catch {
    return { kind: 'failed' }; // the bridge rejected the call: nothing was signed, nothing was posted
  }
  // the person who SIGNED (the OS prompt is the confirmation) has pressed — the post goes even if the screen left afterwards (that only stops the waiting).
  // A flow stopped BEFORE the signature came back posts nothing.
  if (deps.flow?.stopped) return { kind: 'stopped' };
  if (!signed.ok) return { kind: SHELL_REFUSALS[signed.code ?? ''] ?? 'failed' } as PressOutcome;
  if (typeof signed.signed !== 'string' || typeof signed.phone_key_id !== 'string') return { kind: 'failed' };
  const pending: Pending = {
    setupId: input.setupId,
    key: deps.newKey(),
    // closed: the action + the agent the person picked + the shell's two values — never a text · name · path (the signature covers the rest)
    body: { action: input.action, signed: signed.signed, phone_key_id: signed.phone_key_id, ...(input.agentId !== undefined ? { agent_member_id: input.agentId } : {}) },
  };
  return post(pending, deps);
}

export type ClockEditFields = { done?: string; plan?: string; blockers?: string };
export interface EditInput { setupId: string; agentId: string; /** the revision of the row in the report the person read */ baseRev: number; /** ONLY the fields the person touched */ fields: ClockEditFields }
const EDIT_FIELDS = ['done', 'plan', 'blockers'] as const;

/**
 * story #4733 (S5 · P2): a person's edit of ONE agent's clock-out draft, typed on the phone. Same road as a press: the shell reads the list itself, cleans the words (the daemon's own
 * cleaner) and signs a hash of exactly the revision and the touched fields; the web posts what the shell handed back — the cleaned words, never the page's own copy — and follows the command.
 * Only the touched fields are sent: a field the person did not type into is not in the edit, so the computer leaves it exactly as it is.
 */
export async function editClock(input: EditInput, deps: PressDeps): Promise<PressOutcome> {
  const touched = EDIT_FIELDS.filter((k) => typeof input.fields[k] === 'string');
  if (touched.length === 0) return { kind: 'failed' };
  const edit: Record<string, unknown> = { base_rev: input.baseRev };
  for (const k of touched) edit[k] = input.fields[k];
  let signed: PhoneAnswer;
  try {
    signed = await deps.phoneCall('command.sign', { kind: 'clock', setup_id: input.setupId, action: 'out_edit', agent_member_id: input.agentId, edit });
  } catch {
    return { kind: 'failed' };
  }
  if (deps.flow?.stopped) return { kind: 'stopped' };
  if (!signed.ok) return { kind: SHELL_REFUSALS[signed.code ?? ''] ?? 'failed' } as PressOutcome;
  if (typeof signed.signed !== 'string' || typeof signed.phone_key_id !== 'string') return { kind: 'failed' };
  // the words the shell signed (cleaned) are the words posted: the same revision, the same fields — anything else is not what the person approved
  const back = (signed as unknown as { edit?: unknown }).edit;
  if (!isObj(back) || back.base_rev !== input.baseRev) return { kind: 'failed' };
  const backKeys = Object.keys(back).filter((k) => k !== 'base_rev').sort();
  if (backKeys.length !== touched.length || !backKeys.every((k, i) => k === [...touched].sort()[i] && typeof back[k] === 'string')) return { kind: 'failed' };
  const pending: Pending = {
    setupId: input.setupId,
    key: deps.newKey(),
    body: { action: 'out_edit', signed: signed.signed, phone_key_id: signed.phone_key_id, agent_member_id: input.agentId, edit: { ...back } },
  };
  return post(pending, deps);
}

/** the next look at a press whose end is not known: its id when known (follow it), else the same post (same key: the server gives back the command it made, if any) */
export async function checkPress(pending: Pending, deps: PressDeps): Promise<PressOutcome> {
  if (deps.flow?.stopped) return { kind: 'stopped' };
  return pending.commandId ? follow(pending, deps) : post(pending, deps);
}

async function post(pending: Pending, deps: PressDeps): Promise<PressOutcome> {
  let res: Response;
  try {
    res = await fetchWithAuth(`/api/desktop/setups/${encodeURIComponent(pending.setupId)}/clock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...pending.body, idempotency_key: pending.key }),
    });
  } catch {
    return { kind: 'unknown', pending }; // the post may have reached the server — its answer was lost
  }
  if (!res.ok) {
    if (res.status >= 500) return { kind: 'unknown', pending }; // any 5xx may have come after the command was made — followed, never redone
    const code = await codeOf(res);
    if (res.status === 403 || code === 'not_allowed_to_command') return { kind: 'not_allowed' };
    if (code === 'device_unreachable') return { kind: 'unreachable' };
    if (code === 'remote_control_off') return { kind: 'remote_off' };
    if (code === 'phone_not_paired') return { kind: 'not_paired' };
    return { kind: 'failed' }; // another 4xx: refused before anything was made
  }
  let made: { command_id?: string };
  try { made = (await res.json()) as typeof made; } catch { return { kind: 'unknown', pending }; }
  if (!made || typeof made !== 'object' || typeof made.command_id !== 'string') return { kind: 'unknown', pending };
  return follow({ ...pending, commandId: made.command_id }, deps);
}

// follow it: done (the daemon's nine words) · any other end · the window on the wall clock without an end (queued the whole time = never taken)
async function follow(pending: Pending, deps: PressDeps): Promise<PressOutcome> {
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const every = deps.pollMs ?? PRESS_POLL_MS;
  const deadline = now() + (deps.pollMaxMs ?? PRESS_POLL_MAX_MS);
  let everTaken = false; // any state past `queued` was seen: the computer HAS the command — its end is not ours to guess
  const startedAt = now();
  let queuedAt: number | null = null; // the last look that succeeded and found it still `queued` (when)
  while (now() < deadline) {
    await wait(every);
    if (deps.flow?.stopped) return { kind: 'stopped' }; // every look at the command is preceded by this: a stopped flow makes no further request
    if (now() > deadline) break; // a sleep that ended after the window is not one more look
    let r: { state?: string; result_code?: string | null };
    try {
      const got = await fetchWithAuth(`/api/desktop/setups/${encodeURIComponent(pending.setupId)}/clock/commands/${pending.commandId}`);
      if (!got.ok) continue; // a read that failed is not an end — ask again
      r = (await got.json()) as typeof r;
    } catch {
      continue;
    }
    if (!r || typeof r !== 'object') continue;
    if (r.state === 'delivered' || r.state === 'acked') everTaken = true;
    if (r.state === 'queued') queuedAt = now();
    if (r.state === 'done') {
      const result = (CLOCK_RESULTS as readonly unknown[]).includes(r.result_code) ? (r.result_code as ClockResult) : null;
      return result ? { kind: 'done', result } : { kind: 'failed' }; // a word this page does not know is not read as a success
    }
    if (r.state === 'rejected' || r.state === 'failed') {
      if (r.result_code === 'remote_control_off') return { kind: 'remote_off' };
      return { kind: 'failed' };
    }
  }
  // «nothing was stopped» is said only when a look made AFTER the command's life (120 s) still found it queued and never anything else: it was never taken and never will
  // be. A queued look from early on, followed by reads that failed, proves nothing — the computer may have taken it in between: that is `unknown`.
  return !everTaken && queuedAt !== null && queuedAt - startedAt >= COMMAND_LIFE_MS ? { kind: 'expired' } : { kind: 'unknown', pending };
}
