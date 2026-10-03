// story #4532 — pairing this phone with a computer from inside the phone app (명세 b0713c54 «짝짓기 화면 · 짝짓기 숫자 · 폰 확인
// 숫자» 폰 표 · contract 02d2cf71 §10 ① ⑤ v1.11 · design doc 0dceadda v3.1 ④).
//
// The web draws every screen; the shell does the three things it cannot: the camera (the QR's secret stays in the shell), the
// MAC with that secret, and the pairing number from the phone's own key. Each step here is one outcome kind — the screen turns it
// into the spec's line. No step ever sees the secret or the key bytes.

import type { PhoneAnswer } from './phone-bridge';

export interface OfferHead { offer_id: string; setup_id: string; device_name: string; expires_at: string }

export type ScanOutcome =
  | { kind: 'confirm'; head: OfferHead }
  | { kind: 'notOurs' } // not a Sprintable pairing QR (or one this app cannot read)
  | { kind: 'expired' } // the QR's 5 minutes passed
  | { kind: 'cancelled' } // closed the camera
  | { kind: 'failed' };

export type OfferOutcome =
  | { kind: 'sent'; phoneKeyId: string }
  | { kind: 'alreadyPaired' }
  | { kind: 'limit' } // 409 remote_device_limit — three phones already
  | { kind: 'noScreenLock' }
  | { kind: 'biometricRequired' }
  | { kind: 'offerUsed' } // 409 — another phone (or an earlier send) took this QR
  | { kind: 'expired' } // 422 invalid_expiry · or the QR passed its time
  | { kind: 'remoteOff' }
  | { kind: 'unreachable' }
  | { kind: 'setupNotFound' }
  | { kind: 'registerAgain' } // 404 phone_key_not_found — this phone's registration is gone
  | { kind: 'failed' };

export type WaitOutcome =
  | { kind: 'waiting' } // the computer has not taken the offer yet
  | { kind: 'number'; number: string } // the computer took it — pick this number there
  | { kind: 'paired' }
  | { kind: 'notPaired' } // the QR's time passed, or the computer said «different» — the phone cannot tell which
  | { kind: 'failed' };

type Call = (type: string, args?: Record<string, unknown>) => Promise<PhoneAnswer>;
type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
export interface PairDeps { phoneCall: Call; fetch: Fetch }

const json = { 'Content-Type': 'application/json' };

async function read(res: Response): Promise<{ code: string; body: Record<string, unknown> }> {
  try {
    const body = (await res.json()) as Record<string, unknown>;
    const err = body.error as { code?: string } | undefined;
    return { code: err?.code ?? (typeof body.code === 'string' ? body.code : ''), body };
  } catch {
    return { code: '', body: {} };
  }
}

/** The phone's name as the computer shows it (≤ 64) — the app's own web view says what phone it runs on. */
export function phoneLabel(userAgent: string): string {
  if (/iPad/.test(userAgent)) return 'iPad';
  if (/iPhone/.test(userAgent)) return 'iPhone';
  const model = /Android [^;)]*;\s*([^;)]+?)(?:\s+Build\/[^;)]*)?[;)]/.exec(userAgent)?.[1]?.trim();
  if (model && model !== 'K' && model.length <= 64) return model;
  return 'Android';
}

export async function scanPairQr(deps: PairDeps): Promise<ScanOutcome> {
  const r = await deps.phoneCall('pair.scan');
  if (r.ok) {
    const { offer_id, setup_id, device_name, expires_at } = r as unknown as OfferHead;
    if ([offer_id, setup_id, device_name, expires_at].every((v) => typeof v === 'string')) {
      return { kind: 'confirm', head: { offer_id, setup_id, device_name, expires_at } };
    }
    return { kind: 'failed' };
  }
  switch (r.code) {
    case 'cancelled': return { kind: 'cancelled' };
    case 'expired': return { kind: 'expired' };
    case 'not_ours':
    case 'bad': return { kind: 'notOurs' };
    default: return { kind: 'failed' };
  }
}

interface Paired { id: string; pairs: Array<{ setup_id: string }> }

async function myPhones(deps: PairDeps): Promise<Paired[] | null> {
  try {
    const res = await deps.fetch('/api/remote-devices');
    if (!res.ok) return null;
    const body = (await res.json()) as { devices?: Paired[] };
    return Array.isArray(body.devices) ? body.devices : null;
  } catch {
    return null;
  }
}

/** [짝짓기]: register this phone's key (the same key again = the same row) → already paired? → the shell's MAC → the offer. */
export async function sendPairOffer(head: OfferHead, label: string, deps: PairDeps): Promise<OfferOutcome> {
  const key = await deps.phoneCall('device.key.info');
  if (!key.ok) {
    if (key.code === 'no_screen_lock') return { kind: 'noScreenLock' };
    if (key.code === 'biometric_required') return { kind: 'biometricRequired' };
    return { kind: 'failed' };
  }
  let phoneKeyId: string;
  try {
    const res = await deps.fetch('/api/remote-devices', { method: 'POST', headers: json, body: JSON.stringify({ label, public_key: key.public_key }) });
    const { code, body } = await read(res);
    if (!res.ok) return code === 'remote_device_limit' ? { kind: 'limit' } : { kind: 'failed' };
    if (typeof body.id !== 'string') return { kind: 'failed' };
    phoneKeyId = body.id;
  } catch {
    return { kind: 'failed' };
  }
  const phones = await myPhones(deps);
  if (phones?.some((p) => p.id === phoneKeyId && p.pairs.some((x) => x.setup_id === head.setup_id))) return { kind: 'alreadyPaired' };

  const mac = await deps.phoneCall('pair.mac', { offer_id: head.offer_id, phone_key_id: phoneKeyId, label });
  if (!mac.ok || typeof mac.mac !== 'string') return mac.code === 'no_offer' ? { kind: 'expired' } : { kind: 'failed' };
  try {
    const res = await deps.fetch('/api/remote-devices/pairing-offers', {
      method: 'POST', headers: json,
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
    const res = await deps.fetch(`/api/remote-devices/pairing-offers/${head.offer_id}?setup_id=${encodeURIComponent(head.setup_id)}`);
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
  const phones = await myPhones(deps);
  if (phones?.some((p) => p.id === phoneKeyId && p.pairs.some((x) => x.setup_id === head.setup_id))) return { kind: 'paired' };
  if (state === 'expired') return { kind: 'notPaired' };
  if (known) return { kind: 'number', number: known };
  if (typeof reveal !== 'string') return { kind: 'failed' };
  const n = await deps.phoneCall('pair.number', { offer_id: head.offer_id, reveal });
  return n.ok && typeof n.number === 'string' ? { kind: 'number', number: n.number } : { kind: 'failed' };
}
