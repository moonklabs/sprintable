// story #4532 — the phone app's signing bridge (Sprintable mobile shell · design doc 0dceadda v3.1 ②).
//
// The shell puts a one-time handle into the top frame only (`window.__sprintablePhone.claim()`), before any page script runs.
// The web claims it once, as early as the app boots — the handle then removes itself, so a frame that appears later (a
// same-origin iframe such as the PDF blob preview) finds nothing on `parent`. The sender stays in this module's scope, never on
// `window`. Outside the phone app (a browser · the desktop app) there is no handle: `isPhoneApp()` is false and the pairing ·
// signing buttons stay hidden.
//
// What the web may ask (closed shapes — the shell refuses anything else · the fields to sign never come from here):
//   device.auth · device.key.info · pair.scan · pair.mac {offer_id, phone_key_id, label} · pair.number {offer_id, reveal} ·
//   approval.sign {id, decision} · app.settings

type Send = (message: { id: string; v: 1; type: string; args: Record<string, unknown> }) => void;
export type PhoneAnswer = { id: string; ok: boolean; code?: string; [field: string]: unknown };

declare global {
  interface Window {
    __sprintablePhone?: { claim(): Send | null };
    __sprintablePhoneReply?: (answer: PhoneAnswer) => void;
  }
}

let send: Send | null = null;
let seq = 0;
const waiting = new Map<string, (answer: PhoneAnswer) => void>();

/** Claim the shell's handle once (idempotent · SSR-safe). Call as early as the app boots. */
export function claimPhoneBridge(): void {
  if (typeof window === 'undefined' || send) return;
  const handle = window.__sprintablePhone;
  if (!handle || typeof handle.claim !== 'function') return;
  const s = handle.claim();
  if (typeof s !== 'function') return;
  send = s;
  window.__sprintablePhoneReply = (answer) => {
    const done = answer && typeof answer.id === 'string' ? waiting.get(answer.id) : undefined;
    if (!done) return;
    waiting.delete(answer.id);
    done(answer);
  };
}

/** True only inside the phone app, once the handle was claimed. */
export function isPhoneApp(): boolean {
  return send !== null;
}

/** Ask the shell; the answer comes back under the same id (once). Outside the phone app → `{ ok: false, code: 'not_phone_app' }`. */
export function phoneCall(type: string, args: Record<string, unknown> = {}): Promise<PhoneAnswer> {
  const id = `w${Date.now().toString(36)}${(seq++).toString(36)}`;
  if (!send) return Promise.resolve({ id, ok: false, code: 'not_phone_app' });
  const sender = send;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    sender({ id, v: 1, type, args });
  });
}

/** tests only: forget the claim */
export function __resetPhoneBridgeForTest(): void {
  send = null;
  waiting.clear();
}
