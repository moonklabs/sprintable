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
  | { kind: 'key_invalidated' } // a new fingerprint made the phone's key unusable — pair again
  | { kind: 'not_paired' } // 409 phone_not_paired — the request is still open
  | { kind: 'expired' } // the window passed
  | { kind: 'closed' } // withdrawn · rejected · not pending · not answerable any more
  | { kind: 'unreachable' } // the computer is not reachable now
  | { kind: 'failed' }; // anything else — the request is left as it was

type Call = (type: string, args: Record<string, unknown>) => Promise<PhoneAnswer>;

export async function answerOnPhone(id: string, decision: 'allow' | 'deny', deps: { phoneCall: Call }): Promise<AnswerOutcome> {
  const signed = await deps.phoneCall('approval.sign', { id, decision });
  if (!signed.ok) {
    switch (signed.code) {
      case 'cancelled': return { kind: 'cancelled' };
      case 'biometric_required': return { kind: 'biometric_required' };
      case 'no_screen_lock': return { kind: 'no_screen_lock' };
      case 'key_invalidated':
      // PO 07:47Z ①: this phone's key is one the server does not know (it was removed and made again before the shell stopped
      // making keys on the signing path · or the registration is gone) — the same way out: pair this phone again
      case 'not_registered': return { kind: 'key_invalidated' };
      case 'expired': return { kind: 'expired' };
      case 'not_pending':
      case 'not_answerable': return { kind: 'closed' };
      default: return { kind: 'failed' };
    }
  }
  if (typeof signed.signed !== 'string' || typeof signed.phone_key_id !== 'string') return { kind: 'failed' };
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
