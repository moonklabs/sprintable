// story #4532 — pairing this phone with a computer from inside the phone app (명세 b0713c54 «짝짓기 화면 · 짝짓기 숫자 · 폰 확인
// 숫자» 폰 표 · contract 02d2cf71 §10 ① ⑤ v1.11 · design doc 0dceadda v3.1 ④).
//
// The web draws every screen; the shell does the three things it cannot: the camera (the QR's secret stays in the shell), the
// MAC with that secret, and the pairing number from the phone's own key. Each step here is one outcome kind — the screen turns it
// into the spec's line. No step ever sees the secret or the key bytes.

import { computerLabel, deviceKindOf } from '@/lib/device-kind';
import { fetchWithAuth } from '@/lib/db/client';
import type { PhoneAnswer } from './phone-bridge';

/** `version: 2` = the QR of the NEW pairing (the shell scanned it — the choice of procedure is the scanned QR's version and nothing else: story 4972 · lens 808 C-b); a head without it is the old six-digit one, exactly as before */
export interface OfferHead { offer_id: string; setup_id: string; device_name: string; expires_at: string; version?: 2 }

export type ScanOutcome =
  | { kind: 'confirm'; head: OfferHead }
  | { kind: 'notOurs' } // not a Sprintable pairing QR (the shell said so by its own word)
  | { kind: 'qrUnreadable' } // the shell could not read it (an older app does not know a newer computer's QR: «update the app» — or the picture is damaged)
  | { kind: 'expired' } // the QR's 5 minutes passed
  | { kind: 'cancelled' } // closed the camera
  | { kind: 'failed' };

export type OfferOutcome =
  | { kind: 'sent'; phoneKeyId: string }
  | { kind: 'alreadyPaired' }
  | { kind: 'limit' } // 409 remote_device_limit — three phones already
  | { kind: 'taken' } // 409 remote_device_taken — this phone's key is registered to another account (story #4624)
  | { kind: 'takenOtherOrg'; org?: string } // 409 remote_device_other_org — the SAME person's key, paired with a computer of another organization of theirs (story 4695)
  | { kind: 'noScreenLock' }
  | { kind: 'biometricRequired' }
  | { kind: 'offerUsed' } // 409 — another phone (or an earlier send) took this QR
  | { kind: 'expired' } // 422 invalid_expiry · or the QR passed its time
  | { kind: 'remoteOff' }
  | { kind: 'unreachable' }
  | { kind: 'setupNotFound' }
  | { kind: 'registerAgain' } // 404 phone_key_not_found — this phone's registration is gone
  | { kind: 'offerGone' } // 404 offer_not_found — the server knows no such offer of ours (the computer never registered it · it is someone else's · it is gone): NOT «the computer is unreachable» (lens 5842)
  | { kind: 'startedAlready' } // the shell already started this QR (it is used up): a new QR is the only way
  | { kind: 'signedOut' } // the shell could not read the server's list: the person is signed out
  | { kind: 'forbidden' } // the server refused the list read (403): this account has no access to that computer's organization
  | { kind: 'failed' };

export type WaitOutcome =
  | { kind: 'waiting' } // the computer has not taken the offer yet
  | { kind: 'number'; number: string } // the computer took it — pick this number there
  | { kind: 'paired' }
  | { kind: 'notPaired' } // the QR's time passed, or the computer said «different» — the phone cannot tell which
  | { kind: 'failed' };

type Call = (type: string, args?: Record<string, unknown>) => Promise<PhoneAnswer>;
export interface PairDeps { phoneCall: Call; alive?: () => boolean } // `alive`: false once the person left this pairing (a step that has been waiting on the shell then sends nothing)

const json = { 'Content-Type': 'application/json' };

// story 4695 — the phone's pairing page sits outside the dashboard shell, so no X-Org-Id is carried and the server judged the offer by the
// login's DEFAULT org: an account in several orgs got `setup_not_found` for a computer that is theirs. The QR names a computer; the server
// says which org it is in (for a member of that org), and the key, the list, the offer and the wait all go with that org.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const targetOrgOf = new Map<string, string>();

async function findTargetOrg(setupId: string): Promise<string | null> {
  try {
    const res = await fetchWithAuth(`/api/remote-devices/pairing-target?setup_id=${encodeURIComponent(setupId)}`);
    if (!res.ok) return null;
    const body = (await res.json()) as { org_id?: unknown };
    return typeof body.org_id === 'string' && UUID.test(body.org_id) ? body.org_id : null;
  } catch {
    return null;
  }
}

/** the org header of this QR's computer — none when the server did not name one (then the call goes as it always did) */
const orgHeader = (setupId: string): Record<string, string> => {
  const org = targetOrgOf.get(setupId);
  return org ? { 'X-Org-Id': org } : {};
};

/** the organization the server names for «paired in another organization» (error.detail.org_name) — a short clean string, or nothing */
function orgOf(body: Record<string, unknown>): { org?: string } {
  const detail = (body.error as { detail?: { org_name?: unknown } } | undefined)?.detail;
  const name = typeof detail?.org_name === 'string' ? detail.org_name.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) : '';
  return name ? { org: name } : {};
}

async function read(res: Response): Promise<{ code: string; body: Record<string, unknown> }> {
  try {
    const body = (await res.json()) as Record<string, unknown>;
    const err = body.error as { code?: string } | undefined;
    return { code: err?.code ?? (typeof body.code === 'string' ? body.code : ''), body };
  } catch {
    return { code: '', body: {} };
  }
}

/** The device's name as the computer shows it (≤ 64) — the app's own web view says what it runs on. story 4994: the GUEST DESKTOP app is an Electron window — it is named for its computer (device-kind.ts), never a phone's name (it was shown as «Android», the fall-through below). */
export function phoneLabel(userAgent: string): string {
  if (deviceKindOf(userAgent) === 'computer') return computerLabel(userAgent);
  if (/iPad/.test(userAgent)) return 'iPad';
  if (/iPhone/.test(userAgent)) return 'iPhone';
  const model = /Android [^;)]*;\s*([^;)]+?)(?:\s+Build\/[^;)]*)?[;)]/.exec(userAgent)?.[1]?.trim();
  if (model && model !== 'K' && model.length <= 64) return model;
  return 'Android';
}

export async function scanPairQr(deps: PairDeps): Promise<ScanOutcome> {
  const r = await safeCall(deps, 'pair.scan', {});
  if (r.ok) {
    const { offer_id, setup_id, device_name, expires_at } = r as unknown as OfferHead;
    if ([offer_id, setup_id, device_name, expires_at].every((v) => typeof v === 'string')) {
      return { kind: 'confirm', head: { offer_id, setup_id, device_name, expires_at, ...(r.version === 2 ? { version: 2 as const } : {}) } };
    }
    return { kind: 'failed' };
  }
  switch (r.code) {
    case 'cancelled': return { kind: 'cancelled' };
    case 'expired': return { kind: 'expired' };
    case 'not_ours': return { kind: 'notOurs' };
    case 'bad': return { kind: 'qrUnreadable' };
    default: return { kind: 'failed' };
  }
}

interface Paired { id: string; pairs: Array<{ setup_id: string }> }

type PhonesRead = { phones: Paired[] } | { failed: 'signedOut' | 'remoteOff' | 'forbidden' | 'read' };
async function readPhones(setupId: string): Promise<PhonesRead> {
  try {
    const res = await fetchWithAuth('/api/remote-devices', { headers: orgHeader(setupId) });
    if (!res.ok) {
      if (res.status === 401) return { failed: 'signedOut' };
      if (res.status === 403) return { failed: 'forbidden' }; // an organization refusal: not «signed out», not a read to try again
      if ((await read(res)).code === 'remote_control_off') return { failed: 'remoteOff' };
      return { failed: 'read' };
    }
    const body = (await res.json()) as { devices?: Paired[] };
    return Array.isArray(body.devices) ? { phones: body.devices } : { failed: 'read' };
  } catch {
    return { failed: 'read' };
  }
}

/** `sha256:<hex>` of a public key's bytes (the server's fingerprint of it) — null where this view cannot compute one (then the proof is simply made again) */
async function fingerprintOf(publicKeyB64url: string): Promise<string | null> {
  try {
    const bytes = Uint8Array.from(atob(publicKeyB64url.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return 'sha256:' + Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

type PopProof = { payload: string; sig: string };

/**
 * story 5027 (lens 5025 · F1) — before the key is registered the phone proves it holds the key's private half: the server hands out a one-time value, the SHELL signs it (it builds the signed bytes itself from three
 * ids and its own key — the page never names what is signed), and the registration carries the proof. A shell that does not say `key_proof: 1` (an older app) sends none and registers as it always did. A key the
 * server's own list already calls proved (`pop_verified`) is not proved again — no prompt for a phone that has done it. `{}` = go on without a proof · `{ pop }` = go on with it · `{ end }` = this step ends.
 */
async function proveKey(head: OfferHead, publicKey: string, deps: PairDeps): Promise<{ pop?: PopProof } | { end: OfferOutcome }> {
  const caps = await safeCall(deps, 'shell.caps', {});
  const can = caps.ok === true && !!caps.caps && typeof caps.caps === 'object' && (caps.caps as { key_proof?: unknown }).key_proof === 1;
  if (!can) return {};
  const fp = await fingerprintOf(publicKey);
  if (fp) {
    const listed = await readPhones(head.setup_id);
    if ('phones' in listed && listed.phones.some((d) => (d as { fingerprint?: unknown; pop_verified?: unknown }).fingerprint === fp && (d as { pop_verified?: unknown }).pop_verified === true)) return {};
  }
  let ch: { nonce?: unknown; member_id?: unknown; org_id?: unknown };
  try {
    const res = await fetchWithAuth('/api/remote-devices/challenge', { method: 'POST', headers: { ...json, ...orgHeader(head.setup_id) }, body: '{}' });
    if (!res.ok) return { end: { kind: res.status === 401 ? 'signedOut' : 'failed' } };
    ch = ((await res.json()) as { nonce?: unknown; member_id?: unknown; org_id?: unknown }) ?? {};
  } catch {
    return { end: { kind: 'failed' } };
  }
  if (typeof ch.nonce !== 'string' || typeof ch.member_id !== 'string' || typeof ch.org_id !== 'string') return { end: { kind: 'failed' } };
  const proved = await safeCall(deps, 'device.key.prove', { member_id: ch.member_id, org_id: ch.org_id, nonce: ch.nonce });
  if (!proved.ok) {
    if (proved.code === 'no_screen_lock') return { end: { kind: 'noScreenLock' } };
    if (proved.code === 'biometric_required') return { end: { kind: 'biometricRequired' } };
    return { end: { kind: 'failed' } }; // (the person closed the prompt: the same «not sent — try again» as any other step that did not finish)
  }
  const pop = proved.pop as { payload?: unknown; sig?: unknown } | undefined;
  if (!pop || typeof pop.payload !== 'string' || typeof pop.sig !== 'string') return { end: { kind: 'failed' } };
  return { pop: { payload: pop.payload, sig: pop.sig } };
}

/**
 * The first half of both procedures: this phone's key (the shell's own) → the computer's org → register the key (the same key again = the same row) → already paired?
 * → `{ phoneKeyId }`, or the outcome that ends the step. Shared as it was (story 4972 moved these lines into a function; the old procedure's calls and answers are the same ones).
 */
async function prepareKey(head: OfferHead, label: string, deps: PairDeps, opts: { newProcedure?: boolean } = {}): Promise<{ phoneKeyId: string } | { end: OfferOutcome }> {
  const key = await safeCall(deps, 'device.key.info', {});
  if (!key.ok) {
    if (key.code === 'no_screen_lock') return { end: { kind: 'noScreenLock' } };
    if (key.code === 'biometric_required') return { end: { kind: 'biometricRequired' } };
    return { end: { kind: 'failed' } };
  }
  const org = await findTargetOrg(head.setup_id);
  if (org) targetOrgOf.set(head.setup_id, org); else targetOrgOf.delete(head.setup_id);
  let phoneKeyId: string;
  try {
    // story 5027: the proof of holding the key rides with the registration (none from an older shell). A value that ran out on its way (`pop_expired`) is asked for once more — one more prompt, then the step ends.
    let res: Response;
    let attempt = 0;
    for (;;) {
      const proof = typeof key.public_key === 'string' ? await proveKey(head, key.public_key, deps) : {};
      if ('end' in proof) return { end: proof.end };
      res = await fetchWithAuth('/api/remote-devices', { method: 'POST', headers: { ...json, ...orgHeader(head.setup_id) }, body: JSON.stringify({ label, public_key: key.public_key, ...(proof.pop ? { pop: proof.pop } : {}) }) });
      if (res.ok || attempt >= 1 || !proof.pop) break;
      if ((await read(res.clone())).code !== 'pop_expired') break;
      attempt += 1;
    }
    const { code, body } = await read(res);
    if (!res.ok) {
      if (code === 'remote_device_limit') return { end: { kind: 'limit' } };
      if (code === 'remote_device_taken') return { end: { kind: 'taken' } }; // story #4624: its own line, not the general «보내지 못했어요»
      if (code === 'remote_device_other_org') return { end: { kind: 'takenOtherOrg', ...orgOf(body) } }; // story 4695: not «another account» — the same person's phone, another organization
      return { end: { kind: 'failed' } };
    }
    if (typeof body.id !== 'string') return { end: { kind: 'failed' } };
    phoneKeyId = body.id;
  } catch {
    return { end: { kind: 'failed' } };
  }
  // the OLD procedure: a phone that is already paired with this computer ends here (as it always did). The NEW procedure does not decide this on the page: the shell reads the list itself before it makes the commitment and says what it found
  // (a REAL pin → paired again at the final moment · an old line on the list → «remove it on the computer first» · nothing → on) — lens 5842 delta 2
  if (!opts.newProcedure) {
    const r = await readPhones(head.setup_id);
    if ('failed' in r && r.failed === 'forbidden') return { end: { kind: 'forbidden' } }; // (not «no pair»: the list could not be read for want of access)
    if ('phones' in r && r.phones.some((p) => p.id === phoneKeyId && p.pairs.some((x) => x.setup_id === head.setup_id))) return { end: { kind: 'alreadyPaired' } };
  }
  return { phoneKeyId };
}

/** [짝짓기]: register this phone's key (the same key again = the same row) → already paired? → the shell's MAC → the offer. */
export async function sendPairOffer(head: OfferHead, label: string, deps: PairDeps): Promise<OfferOutcome> {
  const prepared = await prepareKey(head, label, deps);
  if ('end' in prepared) return prepared.end;
  const { phoneKeyId } = prepared;

  const mac = await deps.phoneCall('pair.mac', { offer_id: head.offer_id, phone_key_id: phoneKeyId, label });
  if (!mac.ok || typeof mac.mac !== 'string') return mac.code === 'no_offer' ? { kind: 'expired' } : { kind: 'failed' };
  try {
    const res = await fetchWithAuth('/api/remote-devices/pairing-offers', {
      method: 'POST', headers: { ...json, ...orgHeader(head.setup_id) },
      body: JSON.stringify({ setup_id: head.setup_id, offer_id: head.offer_id, phone_key_id: phoneKeyId, label, expires_at: head.expires_at, mac: mac.mac }),
    });
    if (res.ok) return { kind: 'sent', phoneKeyId };
    const { code } = await read(res);
    switch (code) {
      case 'offer_used': return { kind: 'offerUsed' };
      case 'invalid_expiry': return { kind: 'expired' };
      case 'remote_control_off': return { kind: 'remoteOff' };
      case 'device_unreachable': return { kind: 'unreachable' };
      case 'setup_not_found': return { kind: 'setupNotFound' };
      case 'phone_key_not_found': return { kind: 'registerAgain' };
      default: return { kind: 'failed' };
    }
  } catch {
    return { kind: 'failed' };
  }
}

/** One look while waiting (the screen asks every 1.5 s, up to the QR's time). `known` = the number already shown (asked once). */
export async function checkPairOffer(head: OfferHead, phoneKeyId: string, known: string | null, deps: PairDeps): Promise<WaitOutcome> {
  let state = '';
  let reveal: unknown = null;
  try {
    const res = await fetchWithAuth(`/api/remote-devices/pairing-offers/${head.offer_id}?setup_id=${encodeURIComponent(head.setup_id)}`, { headers: orgHeader(head.setup_id) });
    if (!res.ok) return { kind: 'failed' };
    const body = (await res.json()) as { state?: string; reveal?: unknown };
    state = body.state ?? '';
    reveal = body.reveal;
  } catch {
    return { kind: 'failed' };
  }
  if (state === 'sent') return { kind: 'waiting' };
  if (state !== 'revealed' && state !== 'expired') return { kind: 'failed' };
  // after the computer took it (or the time ran out) the pair may have stood: the server's list says so
  const listed = await readPhones(head.setup_id);
  if ('failed' in listed && listed.failed === 'forbidden') return { kind: 'failed' }; // (a list that could not be read for want of access is not «no pair»)
  if ('phones' in listed && listed.phones.some((p) => p.id === phoneKeyId && p.pairs.some((x) => x.setup_id === head.setup_id))) return { kind: 'paired' };
  if (state === 'expired') return { kind: 'notPaired' };
  if (known) return { kind: 'number', number: known };
  if (typeof reveal !== 'string') return { kind: 'failed' };
  const n = await deps.phoneCall('pair.number', { offer_id: head.offer_id, reveal });
  return n.ok && typeof n.number === 'string' ? { kind: 'number', number: n.number } : { kind: 'failed' };
}

// ── story 4972 — the NEW pairing (design ② §5-2 «숫자 절차») ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// The shell does the cryptography (the commitment · the check of the computer's nonce signature · the box key's binding signature on the OS prompt · the 8-digit number · the pin after THIS phone's person pressed [같아요]);
// the web carries the four public messages to the server and back. Nothing here sees the QR's secret or a key of the computer. The procedure is the scanned QR's version (`head.version === 2`) and nothing else.

const sessionUrl = (head: OfferHead, step = ''): string => `/api/remote-devices/pairing-sessions/${head.offer_id}${step}`;
const sessionHeaders = (head: OfferHead) => ({ ...json, ...orgHeader(head.setup_id) });

/** the server's refusals of the pairing messages, as the screen's lines (the same words as the old procedure's where the cause is the same) */
function sessionRefusal(code: string): OfferOutcome | { kind: 'notReady' } {
  switch (code) {
    case 'offer_burned': return { kind: 'offerUsed' }; // another hand got to this QR first (or the offer was ended): «this QR was already used»
    case 'offer_expired': return { kind: 'expired' };
    case 'offer_not_found': return { kind: 'offerGone' }; // the server knows no such offer of ours (not registered · someone else's · gone) — it is not a word about the computer being reachable
    case 'remote_control_off': return { kind: 'remoteOff' };
    case 'device_unreachable': return { kind: 'unreachable' };
    case 'setup_not_found': return { kind: 'setupNotFound' };
    case 'phone_key_not_found': return { kind: 'registerAgain' };
    default: return { kind: 'failed' };
  }
}

/** [페어링] on a v2 QR: register this phone's key → the shell's commitment → the server. `sent` = the commitment is with the computer (the screen then waits for its nonce). */
export async function sendPairCommit(head: OfferHead, label: string, deps: PairDeps): Promise<OfferOutcome | { kind: 'notReady' }> {
  const prepared = await prepareKey(head, label, deps, { newProcedure: true });
  if ('end' in prepared) return prepared.end;
  if (deps.alive && !deps.alive()) return { kind: 'failed' }; // the person left while the key was being registered: nothing goes further
  const { phoneKeyId } = prepared;
  const c = await safeCall(deps, 'pair.commit', { offer_id: head.offer_id, label });
  if (!c.ok || typeof c.commit !== 'string') {
    if (c.code === 'vault_unavailable') return { kind: 'notReady' }; // the key store is not answering just now: try again in a moment
    if (c.code === 'already_committed') return { kind: 'startedAlready' }; // this QR was started on this phone already (the shell holds it)
    // the shell reads the server's list before it makes the commitment: what it could not do is said as it is
    if (c.code === 'signed_out') return { kind: 'signedOut' };
    if (c.code === 'not_registered' || c.code === 'no_key') return { kind: 'registerAgain' };
    if (c.code === 'no_screen_lock') return { kind: 'noScreenLock' };
    if (c.code === 'biometric_required') return { kind: 'biometricRequired' };
    return c.code === 'no_offer' ? { kind: 'expired' } : { kind: 'failed' };
  }
  if (deps.alive && !deps.alive()) return { kind: 'failed' }; // left while the shell was making the commitment: it does not go to the server
  try {
    const res = await fetchWithAuth(sessionUrl(head, '/commit'), { method: 'POST', headers: sessionHeaders(head), body: JSON.stringify({ setup_id: head.setup_id, phone_key_id: phoneKeyId, commit: c.commit }) });
    if (res.ok) return { kind: 'sent', phoneKeyId };
    return sessionRefusal((await read(res)).code);
  } catch {
    return { kind: 'failed' };
  }
}

/** a shell call that never throws: a bridge that rejects ends the step as a plain failure (the screen is never left waiting on a call that is gone) */
const safeCall = async (deps: PairDeps, type: string, args: Record<string, unknown>) => {
  try { return await deps.phoneCall(type, args); } catch { return { id: '', ok: false, code: 'failed' } as Awaited<ReturnType<PairDeps['phoneCall']>>; }
};

export type SessionLook =
  | { kind: 'waiting' } // the computer has not answered the commitment yet
  | { kind: 'nonce'; n_m: string; sig: string } // it did: the shell checks it and asks the person to confirm
  | { kind: 'revealed' } // the reveal is already at the server (an earlier answer was lost on the way back): the shell holds the number — go on to its window
  | { kind: 'ended' } // burned · expired — this pairing is over (the phone cannot tell which: start again with a new QR)
  | { kind: 'failed'; why?: 'signedOut' | 'remoteOff' | 'forbidden' } // a read that failed: signed out (401) or remote control off (409) say so — anything else is «read again» (a 403 may be an organization refusal: not «signed out»)
  | { kind: 'gone' }; // 404 offer_not_found: the server knows no such offer of ours — NOT a failed read of the network

/** One look at the server's state of this pairing (the screen asks every 1.5 s, up to the QR's time). */
export async function lookPairSession(head: OfferHead): Promise<SessionLook> {
  try {
    const res = await fetchWithAuth(`${sessionUrl(head)}?setup_id=${encodeURIComponent(head.setup_id)}`, { headers: orgHeader(head.setup_id) });
    if (!res.ok) {
      if (res.status === 401) return { kind: 'failed', why: 'signedOut' };
      if (res.status === 403) return { kind: 'failed', why: 'forbidden' }; // this account has no access to that organization's computer (not «signed out»)
      const code = (await read(res)).code;
      if (code === 'remote_control_off') return { kind: 'failed', why: 'remoteOff' };
      if (res.status === 404 && code === 'offer_not_found') return { kind: 'gone' };
      return { kind: 'failed' };
    }
    const body = (await res.json()) as { state?: string; n_m?: unknown; sig?: unknown };
    if (body.state === 'committed') return { kind: 'waiting' };
    if (body.state === 'revealed') return { kind: 'revealed' };
    if (body.state === 'nonce' && typeof body.n_m === 'string' && typeof body.sig === 'string') return { kind: 'nonce', n_m: body.n_m, sig: body.sig };
    if (body.state === 'burned' || body.state === 'expired') return { kind: 'ended' };
    return { kind: 'failed' };
  } catch {
    return { kind: 'failed' };
  }
}

export type RevealOutcome =
  | { kind: 'revealed' } // the reveal is at the server: the number is up in the SHELL's own window (never here) for both people to compare
  | { kind: 'cancelled' } // the person did not confirm on the OS prompt — the same nonce may be tried again
  | { kind: 'ended' } // the offer ended (the server burned it)
  | { kind: 'offerGone' } // the server knows no such offer of ours (not registered · someone else's · gone) — its own line
  | { kind: 'integrity' } // the computer's nonce did not fit the key the QR carried (`bad_nonce`): NOT a time-out — a signal worth a line of its own
  | { kind: 'expired' }
  | { kind: 'noScreenLock' | 'biometricRequired' }
  | { kind: 'failed' };

/** The computer's nonce → the shell (it checks the signature with the computer's key from the QR, signs the binding on the OS prompt) → the reveal to the server. The number is not in the shell's reply (it is drawn in the shell's own window by `comparePairSession`). */
export async function revealPairSession(head: OfferHead, nonce: { n_m: string; sig: string }, deps: PairDeps): Promise<RevealOutcome> {
  const r = await safeCall(deps, 'pair.reveal', { offer_id: head.offer_id, n_m: nonce.n_m, sig: nonce.sig });
  if (!r.ok) {
    switch (r.code) {
      case 'cancelled': return { kind: 'cancelled' };
      case 'bad_nonce': return { kind: 'integrity' };
      case 'no_offer': return { kind: 'expired' };
      case 'no_screen_lock': return { kind: 'noScreenLock' };
      case 'biometric_required': return { kind: 'biometricRequired' };
      default: return { kind: 'failed' }; // (busy · key_failed · sign_failed · bad_request …)
    }
  }
  if (deps.alive && !deps.alive()) return { kind: 'ended' }; // the person left this pairing while the prompt was up: nothing goes up
  const reveal = r.reveal as Record<string, unknown> | undefined;
  if (!reveal || typeof reveal.phone_spki !== 'string' || typeof reveal.phone_box_pub !== 'string' || typeof reveal.n_p !== 'string' || typeof reveal.label !== 'string' || typeof reveal.binding_sig !== 'string') return { kind: 'failed' };
  try {
    const res = await fetchWithAuth(sessionUrl(head, '/reveal'), {
      method: 'POST', headers: sessionHeaders(head),
      body: JSON.stringify({ setup_id: head.setup_id, phone_spki: reveal.phone_spki, phone_box_pub: reveal.phone_box_pub, n_p: reveal.n_p, label: reveal.label, binding_sig: reveal.binding_sig }),
    });
    if (res.ok) return { kind: 'revealed' };
    const refusal = sessionRefusal((await read(res)).code);
    return refusal.kind === 'offerUsed' ? { kind: 'ended' } : refusal.kind === 'offerGone' ? { kind: 'offerGone' } : refusal.kind === 'expired' ? { kind: 'expired' } : { kind: 'failed' };
  } catch {
    return { kind: 'failed' };
  }
}

export type CompareOutcome =
  | { kind: 'agreed' } // the person pressed [같아요] in the shell's window: a PROVISIONAL pin in the shell — what is left is the computer's own [같아요], then `finishPairSession`
  | { kind: 'declined' } // [달라요]: nothing was pinned, the offer is ended on both sides
  | { kind: 'closed' } // the window was closed with no answer: the session stays, the person may open it again
  | { kind: 'notReady' } // the key store is not answering just now: open it again in a moment
  | { kind: 'busy' } // another window of the phone app (a card · an instruction) is up: the shell does not push it out — ask again once it is closed
  | { kind: 'expired' }
  | { kind: 'failed' };

/**
 * Open the shell's own window with the 8-digit number and [같아요] / [달라요] (story 4972 · lens 812: the web is served by the server, so it neither draws the number nor says «same» — it only asks
 * the shell to open the window and hears what became of the pairing). A «different» also ends the offer at the server.
 */
export async function comparePairSession(head: OfferHead, deps: PairDeps): Promise<CompareOutcome> {
  const r = await safeCall(deps, 'pair.compare', { offer_id: head.offer_id });
  if (r.ok) {
    if (r.agreed === true) return { kind: 'agreed' };
    await closePairSession(head); // best effort: the server ends it either way when its window passes
    return { kind: 'declined' };
  }
  switch (r.code) {
    case 'cancelled': return { kind: 'closed' };
    case 'vault_unavailable': return { kind: 'notReady' };
    case 'busy': return { kind: 'busy' };
    case 'no_offer':
    case 'expired': return { kind: 'expired' };
    default: return { kind: 'failed' };
  }
}

export type FinishOutcome =
  | { kind: 'pinned' } // the computer is paired with this phone on the server and the shell made its pin real
  | { kind: 'waiting' } // the server does not list the computer yet (its person has not pressed [같아요]): ask again
  | { kind: 'expired' }
  | { kind: 'notReady' } // the key store is not answering just now
  | { kind: 'alreadyPaired' } // a real pin of this computer is there already
  | { kind: 'signedOut' }
  | { kind: 'receiptInvalid' } // the computer sent a confirmation that does not fit this pairing — a forgery attempt must be SEEN (story 4972 · 4a)
  | { kind: 'noReceipt' } // the window ended with no confirmation from the computer (it may have pressed and not been heard)
  | { kind: 'failed' };

/**
 * The computer's person pressed [같아요] too (the page sees this phone paired with the computer in the server's list): ask the shell to make its provisional pin real. The shell READS the server's list itself — the page's word
 * is only «look now»; it can neither make a pin real nor stop one from becoming real (lens 5842 med 1 · PO).
 */
export async function finishPairSession(head: OfferHead, deps: PairDeps): Promise<FinishOutcome> {
  const r = await safeCall(deps, 'pair.finish', { offer_id: head.offer_id });
  if (r.ok) return r.pinned === true ? { kind: 'pinned' } : { kind: 'failed' };
  switch (r.code) {
    case 'not_confirmed':
    case 'busy': return { kind: 'waiting' };
    case 'no_offer':
    case 'expired': return { kind: 'expired' };
    case 'vault_unavailable': return { kind: 'notReady' };
    case 'signed_out': return { kind: 'signedOut' };
    case 'receipt_invalid': return { kind: 'receiptInvalid' };
    case 'no_receipt': return { kind: 'noReceipt' };
    default: return { kind: 'failed' };
  }
}

/** The person left, or the pairing ended on the other side: the shell drops this offer, its provisional pin and its open number window; the server's offer ends too. Best effort, never throws. */
export async function cancelPairSession(head: OfferHead, deps: PairDeps): Promise<{ pinning: boolean }> {
  const r = await safeCall(deps, 'pair.cancel', { offer_id: head.offer_id });
  // the shell is writing the real pin this very moment (the server's list already says the computer holds this phone): not cancelled — the page says «paired»
  const pinning = r.ok && r.pinning === true;
  if (!pinning) await closePairSession(head);
  return { pinning };
}

/** the offer ends on the server (the phone's [달라요] · a cancel before the number): best effort, never throws */
export async function closePairSession(head: OfferHead): Promise<void> {
  try {
    await fetchWithAuth(sessionUrl(head, '/close'), { method: 'POST', headers: sessionHeaders(head), body: JSON.stringify({ setup_id: head.setup_id }) });
  } catch { /* the window ends it */ }
}

/** After this phone's [같아요]: has the computer pinned this phone too (its own [같아요] + its report to the server)? */
export async function lookPaired(head: OfferHead, phoneKeyId: string): Promise<'paired' | 'waiting' | { failed: 'signedOut' | 'remoteOff' | 'forbidden' | 'read' }> {
  const r = await readPhones(head.setup_id);
  if ('failed' in r) return r; // a read that failed is NOT «waiting»: the screen counts it (and says signed-out / remote-control-off at once)
  return r.phones.some((p) => p.id === phoneKeyId && p.pairs.some((x) => x.setup_id === head.setup_id)) ? 'paired' : 'waiting';
}
