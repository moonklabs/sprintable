// story #4532 — answering an agent's permission request from inside the phone app (design doc 0dceadda v3.1 ① · contract 02d2cf71
// §9 ③ · spec b0713c54 B-2 · «폰 서명 · 권한 창 문구» ③).
//
// The web only says which request and which decision. The phone app's shell reads that request from the server itself, builds the
// fields to sign, asks the person on the OS prompt and signs; the web then posts the shell's `signed` to the answer route. Every
// way it ends is one outcome kind — the card turns it into one line (the copy lives in messages `agentPermissions.phone.*`).

import { fetchWithAuth } from '@/lib/db/client';
import type { PhoneAnswer } from './phone-bridge';

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
  | { kind: 'failed' }; // anything else — the request is left as it was

type Call = (type: string, args: Record<string, unknown>) => Promise<PhoneAnswer>;

/**
 * story 4972: a SEALED card's words only the phone can read, so it is answered ON the shell's own sheet ([허용하지 않기] · [허용]) — the web
 * does not know the answer before the person gives it. `opts.sealed`: the decision posted is the one the shell says it SIGNED (its reply's
 * `decision`); the `decision` passed is only the shell's call shape (a stand-in that, were the row not sealed after all, can only deny).
 * A shell that does not say (older) → nothing is posted (`failed`): never an answer the person did not give.
 */
export async function answerOnPhone(id: string, decision: 'allow' | 'deny', deps: { phoneCall: Call }, opts: { sealed?: boolean } = {}): Promise<AnswerOutcome> {
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
      default: return { kind: 'failed' };
    }
  }
  if (typeof signed.signed !== 'string' || typeof signed.phone_key_id !== 'string') return { kind: 'failed' };
  if (opts.sealed) {
    if (signed.decision !== 'allow' && signed.decision !== 'deny') return { kind: 'failed' };
    decision = signed.decision;
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
export type OpenOutcome = { kind: 'opened' } | { kind: 'closed' } | { kind: 'failed' };

export async function openOnPhone(id: string, deps: { phoneCall: Call }): Promise<OpenOutcome> {
  const r = await deps.phoneCall('approval.view', { id });
  if (r.ok) return { kind: 'opened' };
  if (r.code === 'not_pending' || r.code === 'not_answerable') return { kind: 'closed' };
  return { kind: 'failed' };
}
