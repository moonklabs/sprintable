// story 4993 (5a) — the web's side of the SAME-NETWORK direct road (contracts/direct-bridge.json: the bridge the shell answers; PR 4c-1). A command goes to the computer over the phone's own Wi-Fi when the shell can and the computer takes it, and only
// when it does not does the web post it to the server as it always did. The web asks; the SHELL decides what may ride (a sealed instruction · a signed stop or end — never a plain instruction), so nothing here is a judgement of fitness.
//
// What this file is: a few small steps with a time box each — a press NEVER waits for a road to be made (no road → the server at once, the road opened behind the press), and a step that may have SENT is never repeated:
//   · `shell.caps` says `direct: 1` (a shell that does not know the question or does not say 1 → the server, as before)
//   · the road is `ready` (caps · status answered within PROBE_BUDGET_MS); else → the server AT ONCE, and an `idle` road is asked to open behind the press (the next press finds it ready; a road already being made is not opened again)
//   · `direct.send` of the ONE row (built here exactly as the server builds the payload of the same press — contracts/direct-rows.json is the one file both read) within SEND_BUDGET_MS:
//       sent:true → 'sent' · sent:false for a word that says nothing was written (not_open · busy · too_big · not_allowed · bad_row · no_road) → 'not_sent' · sent:false for a word after the frame may have reached the Mac (ack · closed · protocol) → 'missed'
//       (the server's POST follows, and a «replay» refused there is NOT told as a failure — see `outcomeOfResult`) · no answer in time → 'maybe' (it may have gone: followed, never posted)
// Nothing about the road (address · port · ticket) is ever in what comes back to this page — the contract says so, the shell keeps to it.
import type { PhoneAnswer } from './phone-bridge';

/** the two LOCAL questions before a press may use the road (does this shell have it · is it ready) share this box; a press never waits for a road to be MADE — it goes to the server at once and the road is opened behind it */
export const DIRECT_PROBE_BUDGET_MS = 1_000;
export const DIRECT_SEND_BUDGET_MS = 10_000;
/** one ask of the shell for a command's word (`direct.result`) waits this long; a bridge that never answers is «no answer», asked again until the two minutes are up */
export const DIRECT_RESULT_CALL_MS = 5_000;

type Call = (type: string, args: Record<string, unknown>) => Promise<PhoneAnswer>;
/** how long after one `direct.open` another is not fired for the same computer: two presses together (or one right after the other) ask the shell once */
export const DIRECT_OPEN_AGAIN_MS = 5_000;
export interface DirectDeps { phoneCall: Call; now?: () => number; budget?: { probe?: number; send?: number }; /** the times `direct.open` was last fired, by computer (the page keeps one for all presses) */ openFired?: Map<string, number> }
/** sent · not_sent (certainly nothing went out) · maybe (no answer in time: it may have gone) · missed (the shell said «not sent» for a reason after the frame may have reached the Mac — no verified receipt · the road broke · a frame that was not understood) */
type Went = 'sent' | 'not_sent' | 'maybe' | 'missed';
const MAY_HAVE_ARRIVED = new Set(['ack', 'closed', 'protocol']);
interface PendingLike { verb: string; key: string; body: Record<string, unknown>; sealed?: true; /** a start names its agent here (the server takes it from the URL, not the body) */ agentId?: string }

/** when `direct.open` was last fired, by computer — ALL presses of the page (an instruction · a stop · a start · a clock press) share it: a press never opens a road another press is already asking for */
export const openFired = new Map<string, number>();

const TIMED_OUT = Symbol('timed out');
/** a call of the shell started — a bridge that THROWS before it returns anything is a call that never went (and a rejection is a call whose end is not known: each caller says what that means for it) */
function start(call: Call, type: string, args: Record<string, unknown>): Promise<PhoneAnswer> { try { return Promise.resolve(call(type, args)); } catch (e) { return Promise.reject(e); } }
function within<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(TIMED_OUT), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(TIMED_OUT); });
  });
}

/** one call of the shell within a time box: its answer, or null (no answer in time · the call failed) */
export async function callWithin(call: Call, type: string, args: Record<string, unknown>, ms: number): Promise<PhoneAnswer | null> { const r = await within(start(call, type, args), ms); return r === TIMED_OUT ? null : r; }

/** the direct row of a press: what the Mac would read from the server's line for the same press — or null (a kind that does not ride the road: a plain instruction, anything else) */
export function directRow(pending: PendingLike, nowMs: number): Record<string, unknown> | null {
  const b = pending.body;
  if (pending.verb === 'start') {
    // story 4993 (5b-1): a START — the server's payload for it is {agent_member_id (the URL's agent), project_id, signed}; it has no session yet (session_key null)
    if (typeof pending.agentId !== 'string' || pending.agentId === '' || typeof b.project_id !== 'string' || b.project_id === '' || typeof b.signed !== 'string' || b.signed === '') return null;
    return rowOf(pending, nowMs, 'start_session', null, { agent_member_id: pending.agentId, project_id: b.project_id, signed: b.signed });
  }
  if (pending.verb === 'clock') {
    // story 4993 (5b-1): a CLOCK press of ONE agent (or of the computer's setup without the whole-computer mark) — the server's payload is {action, signed[, agent_member_id]}. The press of the WHOLE computer (`computer: true`: the server counts the agents itself and
    // writes a `scope` the web cannot) and an edit (`edit`: a draft's fields) never ride the road — the server's way, as before
    if (b.computer !== undefined || b.edit !== undefined || typeof b.action !== 'string' || b.action === '' || typeof b.signed !== 'string' || b.signed === '') return null;
    if (b.agent_member_id !== undefined && (typeof b.agent_member_id !== 'string' || b.agent_member_id === '')) return null;
    return rowOf(pending, nowMs, 'clock', null, { action: b.action, signed: b.signed, ...(b.agent_member_id !== undefined ? { agent_member_id: b.agent_member_id } : {}) });
  }
  const kind = b.kind; const sessionKey = b.session_key;
  if (typeof sessionKey !== 'string' || sessionKey === '') return null;
  let payload: Record<string, unknown>;
  if (kind === 'send_prompt') {
    // only the SEALED shape — the words are inside the envelope; a plain instruction is never a direct row
    if (pending.sealed !== true || !b.envelope || typeof b.envelope !== 'object' || Array.isArray(b.envelope) || typeof b.conversation_id !== 'string') return null;
    payload = { session_key: sessionKey, conversation_id: b.conversation_id, envelope: b.envelope };
  } else if (kind === 'stop_session' || kind === 'end_session') {
    if (typeof b.signed !== 'string' || b.signed === '') return null;
    payload = { session_key: sessionKey, signed: b.signed };
  } else return null;
  return rowOf(pending, nowMs, kind, sessionKey, payload);
}

function rowOf(pending: PendingLike, nowMs: number, kind: string, sessionKey: string | null, payload: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof pending.key !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(pending.key)) return null;
  return { command_id: pending.key, kind, session_key: sessionKey, payload, created_at: new Date(nowMs).toISOString() };
}

/** ask the shell to open the road — and look away: a call that throws at once or a promise that rejects is nobody's business here (the press has gone to the server already) */
function openBehind(call: Call, setupId: string): void {
  start(call, 'direct.open', { setup_id: setupId }).catch(() => undefined);
}

/** try the direct road for ONE press (see the head of this file) */
export async function tryDirect(setupId: string, pending: PendingLike, deps: DirectDeps): Promise<Went> {
  const now = deps.now ?? Date.now;
  const row = directRow(pending, now());
  if (!row) return 'not_sent';
  // ONE small box for the two local questions (caps · status) — on the real clock: `deps.now` is the command's wall clock, which a test may move by leaps
  const t0 = Date.now(); const probeBudget = deps.budget?.probe ?? DIRECT_PROBE_BUDGET_MS; const left = () => probeBudget - (Date.now() - t0);
  const caps = await within(start(deps.phoneCall, 'shell.caps', {}), Math.max(1, left()));
  if (caps === TIMED_OUT || caps.ok !== true || !caps.caps || typeof caps.caps !== 'object' || (caps.caps as { direct?: unknown }).direct !== 1) return 'not_sent';
  if (left() <= 0) return 'not_sent';
  const status = await within(start(deps.phoneCall, 'direct.status', { setup_id: setupId }), Math.max(1, left()));
  if (status === TIMED_OUT || status.ok !== true) return 'not_sent';
  if (status.state !== 'ready') {
    // NO ROAD YET: this press goes to the server AT ONCE (the person never waits for a door to be made — the way there is the server, a turn to the computer and back, 1–4 s). The road is opened BEHIND it so the next press finds it ready; a road already being made
    // (asking · connecting · proving) is not opened again, and what the open says is nobody's business here (a refusal is the shell's five quiet minutes)
    if (status.state === 'idle') {
      const fired = deps.openFired; const last = fired?.get(setupId);
      if (last === undefined || Date.now() - last >= DIRECT_OPEN_AGAIN_MS) { fired?.set(setupId, Date.now()); openBehind(deps.phoneCall, setupId); }
    }
    return 'not_sent';
  }
  if (left() <= 0) return 'not_sent'; // (the box is spent: the road is not used on borrowed time)
  let call: Promise<PhoneAnswer>; try { call = Promise.resolve(deps.phoneCall('direct.send', { setup_id: setupId, row })); } catch { return 'not_sent'; } // (the bridge threw before it took the row: nothing went out — the server's POST)
  const sent = await within(call, deps.budget?.send ?? DIRECT_SEND_BUDGET_MS);
  if (sent === TIMED_OUT) return 'maybe'; // it may have gone out: it is followed, never posted
  if (sent.ok === true && sent.sent === true) return 'sent';
  return sent.ok === true && sent.sent === false && typeof sent.why === 'string' && MAY_HAVE_ARRIVED.has(sent.why) ? 'missed' : 'not_sent';
}

/**
 * story 4993 (5a · 5b-1): follow a press that went (or may have gone) over the direct road — ask the shell for its word (`direct.result`) every `pollMs`, `pollMaxMs` at most (the wall clock's, with the page's own clock and a count of asks as belts, a
 * wait cut at the end, every ask in its own box: see the rounds of 5890). `decide` reads the daemon's own words (`state` · `code`) as the flow's outcome or `null` = not an end yet; `unknown()` is the end of the time or the shell's own «it has none»;
 * `halted()` (a flow whose screen was left) is looked at after every wait: an outcome there ends it with no further ask. The press is NEVER posted from here: the server has no row for it.
 */
export async function followDirectResult<T>(setupId: string, key: string, o: {
  phoneCall: Call; wait?: (ms: number) => Promise<void>; now?: () => number; pollMs: number; pollMaxMs: number;
  decide: (r: { state: string; code: string | null }) => Promise<T | null> | T | null; unknown: () => T; halted?: () => T | null;
}): Promise<T> {
  const wait = o.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const every = o.pollMs;
  const maxMs = o.pollMaxMs; const deadline = now() + maxMs;
  // the two minutes are the wall clock's; the count of asks is a second belt (a clock that does not move — a stand-in that waits for nothing — can never hold a press for ever)
  const askMax = Math.ceil(maxMs / Math.max(1, every)) + 2;
  const realDeadline = Date.now() + maxMs; // (the page's own clock too: `deps.now` is injectable, and a frozen one must not turn two minutes into six)
  for (let asked = 0; now() < deadline && Date.now() < realDeadline && asked < askMax; asked++) {
    // the wait is cut at the two minutes' end too: a page that is hidden (a wait that never comes back) cannot hold a press past it
    await Promise.race([wait(every), new Promise<void>((r) => setTimeout(r, Math.max(1, Math.min(deadline - now(), realDeadline - Date.now()))))]);
    const stopped = o.halted?.(); if (stopped) return stopped; // (every ask is preceded by this: a flow that was left makes no further ask)
    if (now() >= deadline || Date.now() >= realDeadline) break; // (the wait itself may have been the end of the two minutes: no ask is started on borrowed time)
    const a = await callWithin(o.phoneCall, 'direct.result', { setup_id: setupId, command_id: key }, Math.max(1, Math.min(DIRECT_RESULT_CALL_MS, deadline - now(), realDeadline - Date.now())));
    if (!a || a.ok !== true) continue; // a call that did not answer is not an end — ask again
    if (a.state === 'pending') continue;
    if (a.state === 'unknown') return o.unknown();
    if (a.state !== 'done' && a.state !== 'failed' && a.state !== 'rejected') continue;
    const end = await o.decide({ state: a.state, code: typeof a.code === 'string' ? a.code : null });
    if (end !== null) return end;
  }
  return o.unknown();
}

/** a result of «replay» for a press that went over the road (or was missed after the frame may have arrived): the computer already had it — not a failure of what ran */
export const REPLAY_WORDS: ReadonlySet<string> = new Set(['reused', 'envelope_replay']);
