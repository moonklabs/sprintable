// story #4532 — the phone app's signing bridge (Sprintable mobile shell · design doc 0dceadda v3.1 ②).
//
// The shell puts a one-time handle into the top frame only (`window.__sprintablePhone.claim(receive)`), before any page script
// runs. The web claims it once, as early as the app boots, handing over its own receiver — the handle then removes itself, so a
// frame that appears later (a same-origin iframe such as the PDF blob preview) finds nothing on `parent`. The sender and the
// receiver stay in closures (this module's · the shell's), never on `window`; the shell's one answer door hands an answer to the
// receiver only with the shell's token (PO 06:07Z ①). Outside the phone app (a browser · the desktop app) there is no handle:
// `isPhoneApp()` is false and the pairing · signing buttons stay hidden.
//
// No call waits forever (PO 06:07Z ②): an answer that never comes (the web view reloaded during the OS prompt, an injection lost)
// ends the call as `timeout` after the signing window (5 min), and leaving the page ends every waiting call — the card gets its
// buttons back. A late answer after that is dropped (nobody waits): what it signed is never posted, so nothing runs.
//
// What the web may ask (closed shapes — the shell refuses anything else · the fields to sign never come from here):
//   device.auth · device.key.info · pair.scan · pair.mac {offer_id, phone_key_id, label} · pair.number {offer_id, reveal} ·
//   approval.sign {id, decision} · app.settings

type Send = (message: { id: string; v: 1; type: string; args: Record<string, unknown> }) => void;
export type PhoneAnswer = { id: string; ok: boolean; code?: string; [field: string]: unknown };

declare global {
  interface Window {
    __sprintablePhone?: { claim(receive: (answer: PhoneAnswer) => void): Send | null };
  }
}

/** a call's longest wait — the signing window (contract §9 ③: a signature is good for 5 min) */
export const PHONE_CALL_MAX_MS = 5 * 60 * 1000;

let send: Send | null = null;
// story #4661 — whoever shows the phone's state subscribes here: the claim is the one change that flips isPhoneApp()
const phoneAppListeners = new Set<() => void>();
let seq = 0;
const waiting = new Map<string, (answer: PhoneAnswer) => void>();

function receive(answer: PhoneAnswer): void {
  const done = answer && typeof answer.id === 'string' ? waiting.get(answer.id) : undefined;
  if (!done) return;
  waiting.delete(answer.id);
  done(answer);
}

/** end every waiting call (the page is going away) — each resolves as `page_hidden` */
function endAll(): void {
  for (const [id, done] of [...waiting]) { waiting.delete(id); done({ id, ok: false, code: 'page_hidden' }); }
}

/**
 * Story 4964 — the shell's handle can arrive AFTER the page's first render. React Native WebView on Android hands the «before content
 * loaded» script over from onPageStarted with evaluateJavascript (not a document-start script), so under load the page can run first; a claim
 * made once, at that render, then reads «not the phone app» and the pairing screen says «open this in the phone app». Inside a React Native
 * WebView (`window.ReactNativeWebView` is there from the start) a missing handle is therefore looked for again — every
 * LATE_CLAIM_EVERY_MS up to LATE_CLAIM_MAX_MS — until it is claimed. Outside the phone app nothing is scheduled. The handle is still taken
 * the moment it exists, so the window in which a same-origin frame could reach it first is no wider than the poll step.
 */
export const LATE_CLAIM_EVERY_MS = 50;
export const LATE_CLAIM_MAX_MS = 5_000;
let lateWatch: ReturnType<typeof setInterval> | null = null;

function inReactNativeWebView(): boolean {
  return typeof window !== 'undefined' && typeof (window as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView === 'object' && (window as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView !== null;
}

function stopLateWatch(): void {
  if (lateWatch !== null) { clearInterval(lateWatch); lateWatch = null; }
}

/** one look at the shell's handle: the function that sends once it is claimed, else null (no handle · refused). A claim() that throws is thrown. */
function lookForHandle(): Send | null {
  const handle = window.__sprintablePhone;
  if (!handle || typeof handle.claim !== 'function') return null;
  const s = handle.claim(receive);
  return typeof s === 'function' ? s : null;
}

/** the claim stands: from here on the readers are told (an exception of theirs is theirs — it is not caught here) */
function adopt(s: Send): void {
  send = s;
  window.addEventListener('pagehide', endAll);
  for (const listen of [...phoneAppListeners]) listen();
}

/** Claim the shell's handle once (idempotent · SSR-safe). Call as early as the app boots. */
export function claimPhoneBridge(): void {
  if (typeof window === 'undefined' || send) return;
  const first = lookForHandle();
  if (first) { stopLateWatch(); adopt(first); return; } // a re-render can find the handle before the look's next step: the look ends with it
  if (lateWatch !== null || !inReactNativeWebView()) return;
  const startedAt = Date.now();
  lateWatch = setInterval(() => {
    if (Date.now() - startedAt >= LATE_CLAIM_MAX_MS) { stopLateWatch(); return; } // a step the page was too busy to run on time does not take a handle that came after the cap
    let s: Send | null = null;
    let broke = false;
    // only the shell's claim() is guarded: one that throws ends the look (it would throw again every step) — never an interval that outlives the cap
    try { s = send === null ? lookForHandle() : null; } catch { broke = true; }
    if (s || broke || send !== null) stopLateWatch();
    if (s) adopt(s);
  }, LATE_CLAIM_EVERY_MS);
}

/** True only inside the phone app, once the handle was claimed. */
export function isPhoneApp(): boolean {
  return send !== null;
}

/** story #4661 — tell me when the phone state changes (a claim that comes after the first render). For useSyncExternalStore. */
export function subscribePhoneApp(listen: () => void): () => void {
  phoneAppListeners.add(listen);
  return () => { phoneAppListeners.delete(listen); };
}

/** Ask the shell; the answer comes back under the same id (once). Outside the phone app → `{ ok: false, code: 'not_phone_app' }`. */
export function phoneCall(type: string, args: Record<string, unknown> = {}): Promise<PhoneAnswer> {
  const id = `w${Date.now().toString(36)}${(seq++).toString(36)}`;
  if (!send) return Promise.resolve({ id, ok: false, code: 'not_phone_app' });
  const sender = send;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { if (waiting.delete(id)) resolve({ id, ok: false, code: 'timeout' }); }, PHONE_CALL_MAX_MS);
    waiting.set(id, (answer) => { clearTimeout(timer); resolve(answer); });
    sender({ id, v: 1, type, args });
  });
}

/** tests only: forget the claim */
export function __resetPhoneBridgeForTest(): void {
  send = null;
  stopLateWatch();
  waiting.clear();
  if (typeof window !== 'undefined') window.removeEventListener('pagehide', endAll);
}
