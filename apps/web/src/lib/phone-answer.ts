// story #4532 — answering an agent's permission request from inside the phone app (design doc 0dceadda v3.1 ① · contract 02d2cf71
// §9 ③ · spec b0713c54 B-2 · «폰 서명 · 권한 창 문구» ③).
//
// The web only says which request and which decision. The phone app's shell reads that request from the server itself, builds the
// fields to sign, asks the person on the OS prompt and signs; the web then posts the shell's `signed` to the answer route. Every
// way it ends is one outcome kind — the card turns it into one line (the copy lives in messages `agentPermissions.phone.*`).

import { fetchWithAuth } from '@/lib/db/client';
import type { PhoneAnswer } from './phone-bridge';
import { followDirectResult, openFired, tryDirect } from './phone-direct';

export type AnswerOutcome =
  | { kind: 'answered'; decision: 'allow' | 'deny' }
  | { kind: 'answered_by'; name: string | null; decision: 'allow' | 'deny' | null } // someone else answered first
  | { kind: 'cancelled' } // the person did not confirm on the OS prompt — the request is still open
  | { kind: 'biometric_required' } // API 24–29 with no fingerprint enrolled
  | { kind: 'no_screen_lock' } // no screen lock: no key can be made or used
  | { kind: 'key_invalidated' } // the phone's key is gone or unusable (the screen lock was turned off) — pair again
  | { kind: 'signed_out' } // the shell read with no session (401) — the request stays; after signing in its buttons are back (Yuna · PO 09:31Z)
  | { kind: 'not_registered' } // the server does not know this phone's key (removed under «원격 기기») — pair again (Yuna 07:58Z)
  | { kind: 'not_paired' } // 409 phone_not_paired — the request is still open
  | { kind: 'expired' } // the window passed
  | { kind: 'closed' } // withdrawn · rejected · not pending · not answerable any more
  | { kind: 'unreachable' } // the computer is not reachable now
  | { kind: 'not_ready' } // story 4972: the shell's key store is not answering just now (`vault_unavailable`) — try again in a moment; the request is still open
  | { kind: 'cannot_open' } // story 4972: the shell would not open this request's card (`card_refused`: the envelope is not this request's · a plain card from a computer that seals) — the terminal answers it
  | { kind: 'failed' }; // anything else — the request is left as it was

type Call = (type: string, args: Record<string, unknown>) => Promise<PhoneAnswer>;

/**
 * story 4972: a SEALED card's words only the phone can read, so it is answered ON the shell's own sheet ([허용하지 않기] · [허용]) — the web
 * does not know the answer before the person gives it. The decision posted is the one the shell says it SIGNED (its reply's `decision`), whenever it
 * says one (lens 5838 low 1 — not the web's own guess of «sealed» that picks whose word counts):
 *  · a shell that says one → that one; for a card the web did not call sealed it must equal the pressed one, else nothing is posted (`failed`);
 *  · a shell that says nothing (older): the pressed one — unless `opts.sealed` (the pressed value is only the call's stand-in shape then) → `failed`.
 * Nothing is ever posted that the person did not choose.
 */
/** story 4993 (5b-2): what an answer needs to go over the same-network direct road instead of the server — the request's own values (the list carries them while it is answerable) */
export interface DirectAnswer { setupId: string; sessionKey: string; requestId: string; stage?: 'ask' | 'confirm'; host?: string | null }
export interface AnswerDeps { phoneCall: Call; newKey?: () => string; wait?: (ms: number) => Promise<void>; now?: () => number; pollMs?: number; pollMaxMs?: number }
/** an answer's end is looked for every 1.5 s, two minutes at most (the same times as a command's) */
export const ANSWER_POLL_MS = 1_500;
export const ANSWER_POLL_MAX_MS = 120_000;

export async function answerOnPhone(id: string, decision: 'allow' | 'deny', deps: AnswerDeps, opts: { sealed?: boolean; direct?: DirectAnswer } = {}): Promise<AnswerOutcome> {
  const signed = await deps.phoneCall('approval.sign', { id, decision });
  if (!signed.ok) {
    switch (signed.code) {
      case 'cancelled': return { kind: 'cancelled' };
      case 'biometric_required': return { kind: 'biometric_required' };
      case 'no_screen_lock': return { kind: 'no_screen_lock' };
      case 'key_invalidated': return { kind: 'key_invalidated' };
      // [SID:4834] the shell holds no key at all (never paired · or the OS dropped it): «not paired», not «your lock settings changed · pair again»
      case 'no_key': return { kind: 'not_paired' };
      // PO 07:47Z ①: a key the server does not know (its registration was removed · or made again before the shell stopped making
      // keys on the signing path) — pair again, never «press again»; its own line, since the lock may not have changed (Yuna 07:58Z)
      case 'not_registered': return { kind: 'not_registered' };
      // Kadir · PO 09:31Z ②: the shell's read of the rows was refused for no session — never «already answered» (a dead end)
      case 'signed_out': return { kind: 'signed_out' };
      case 'expired': return { kind: 'expired' };
      case 'not_pending':
      case 'not_answerable': return { kind: 'closed' };
      case 'vault_unavailable': return { kind: 'not_ready' };
      case 'card_refused': return { kind: 'cannot_open' };
      default: return { kind: 'failed' };
    }
  }
  if (typeof signed.signed !== 'string' || typeof signed.phone_key_id !== 'string') return { kind: 'failed' };
  const said = signed.decision === 'allow' || signed.decision === 'deny' ? signed.decision : null;
  if (signed.decision !== undefined && said === null) return { kind: 'failed' }; // a reply that names something else is a broken shell
  if (said === null) {
    if (opts.sealed) return { kind: 'failed' };
  } else if (!opts.sealed && said !== decision) {
    return { kind: 'failed' };
  } else {
    decision = said;
  }
  // story 4993 (5b-2): the same-network direct road FIRST — the person's answer reaches the computer over the phone's own Wi-Fi when the shell and the computer can, and the server's POST follows only when they cannot (no road yet: at once, the road opened behind it).
  // The computer takes an answer to a request ONCE: a second one (another phone's) is its own `already_answered` — the same «already answered» line the server gives. The server's row closes when the computer reports the request resolved (its usual report).
  if (opts.direct?.setupId) {
    const d = opts.direct; const key = deps.newKey ? deps.newKey() : (globalThis.crypto?.randomUUID?.() ?? '');
    const body: Record<string, unknown> = { session_key: d.sessionKey, request_id: d.requestId, decision, signed: signed.signed, ...(d.stage === 'confirm' ? { stage: 'confirm', host: d.host } : {}) };
    const went = await tryDirect(d.setupId, { verb: 'approval', key, body }, { ...deps, openFired });
    if (went === 'sent' || went === 'maybe') {
      return followDirectResult<AnswerOutcome>(d.setupId, key, {
        phoneCall: deps.phoneCall, wait: deps.wait, now: deps.now, pollMs: deps.pollMs ?? ANSWER_POLL_MS, pollMaxMs: deps.pollMaxMs ?? ANSWER_POLL_MAX_MS,
        decide: (r) => outcomeOfDirectResult(r, decision), unknown: () => ({ kind: 'failed' }), // (the end is not known: the request is left as it was — the card's own read settles it)
      });
    }
    // a miss after the frame may have reached the computer, or no road: the server's way, as before (a replay there is the computer saying it already had it)
  }
  let res: Response;
  try {
    res = await fetchWithAuth(`/api/agent-permission-requests/${id}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision, signed: signed.signed, phone_key_id: signed.phone_key_id }),
    });
  } catch {
    return { kind: 'failed' };
  }
  if (res.ok) return { kind: 'answered', decision };
  let code = '';
  let detail: { answered_by_name?: string | null; decision?: 'allow' | 'deny' | null } = {};
  try {
    const body = (await res.json()) as { error?: { code?: string }; detail?: typeof detail; code?: string };
    code = body.error?.code ?? body.code ?? '';
    detail = body.detail ?? {};
  } catch { /* no body: by status below */ }
  if (code === 'phone_not_paired') return { kind: 'not_paired' };
  if (code === 'already_answered') return { kind: 'answered_by', name: detail.answered_by_name ?? null, decision: detail.decision ?? null };
  if (code === 'device_unreachable') return { kind: 'unreachable' };
  if (code === 'expired' || (res.status === 410 && code !== 'withdrawn')) return { kind: 'expired' };
  if (code === 'withdrawn' || code === 'remote_control_off') return { kind: 'closed' };
  return { kind: 'failed' };
}

/**
 * story 4972: «open it in the app» — a sealed card read on the shell's own sheet with nothing to sign (a terminal-only question has no
 * buttons): the web names the row, the shell reads it itself. `ok` = the sheet was shown and closed.
 */
export type OpenOutcome = { kind: 'opened' } | { kind: 'closed' } | { kind: 'not_ready' } | { kind: 'cannot_open' } | { kind: 'failed' };

export async function openOnPhone(id: string, deps: { phoneCall: Call }): Promise<OpenOutcome> {
  const r = await deps.phoneCall('approval.view', { id });
  if (r.ok) return { kind: 'opened' };
  if (r.code === 'not_pending' || r.code === 'not_answerable') return { kind: 'closed' };
  if (r.code === 'vault_unavailable') return { kind: 'not_ready' };
  if (r.code === 'card_refused') return { kind: 'cannot_open' };
  return { kind: 'failed' };
}

/**
 * story 4993 (5b-2): how the computer's word for a direct answer reads as the card's line — the same lines the server's answer gives: taken → answered · «already answered» → the server's `answered_by` (no name · no decision: a computer does not say them) ·
 * an unknown request (it left the computer) → closed · the window passed (`expired` · the host's `answer_expired`) → expired · remote control off → closed · anything else → failed (the request stays; the card's read settles it)
 */
function outcomeOfDirectResult(r: { state: string; code: string | null }, decision: 'allow' | 'deny'): AnswerOutcome | null {
  if (r.state === 'done') return { kind: 'answered', decision };
  if (r.state !== 'rejected' && r.state !== 'failed') return null;
  switch (r.code) {
    case 'already_answered': return { kind: 'answered_by', name: null, decision: null };
    case 'unknown_request': return { kind: 'closed' };
    case 'expired':
    case 'answer_expired': return { kind: 'expired' };
    case 'remote_control_off': return { kind: 'closed' };
    default: return { kind: 'failed' }; // (a signature the computer refused · a replay — it already had this very answer — · any other word: the request is left as it was)
  }
}
