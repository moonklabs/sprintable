// story 4978 (C1b-phone) — the record KEY handoff, the web's half. The phone's shell holds every rule (it opens what computers put for this phone, keeps the keys, seals what this phone hands a computer it just paired with — and the person's choice beside the
// pairing number is the SHELL's own window's word, never the web's). This module only CARRIES bytes between the shell and this app's own routes:
//   takeHandoffs  — read the rows computers put for this phone (`GET /api/desktop/record-handoffs`), hand them to the shell (`handoff.take`), and post `received` for exactly the rows the shell answered `taken`. Nothing of an envelope is read, parsed or
//                   judged here; a row the shell did not take stays on the server (it runs out there, and the computer then seals a new one).
//   sendHandoff   — after this phone paired with a computer: ask the shell for the envelope (`handoff.make` — it says nothing, or an envelope, by the person's choice) and put it (`PUT …/setups/{id}/record-handoffs/{phone}`).
// What an outcome says is a closed word of this table; nobody here writes a sentence. A word the shell or the server has and this table has not is `failed`.

import { fetchWithAuth } from '@/lib/db/client';
import type { PhoneAnswer } from './phone-bridge';

type Call = (type: string, args?: Record<string, unknown>) => Promise<PhoneAnswer>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** the server's page (its LIST_MAX) — and the shell's `handoff.take` bound */
export const HANDOFF_PAGE = 24;

export type TakeOutcome =
  | { kind: 'done'; seen: number; taken: number; later: number; rejected: number; acked: number }
  | { kind: 'unsupported' } // an older shell: it does not know the handoff calls
  | { kind: 'no_phone' } // this phone's key is not among the person's keys on the server
  | { kind: 'signed_out' }
  | { kind: 'unreachable' }
  | { kind: 'shell'; code: string } // the shell refused the whole call: its stores or vault did not answer (the rows stay)
  | { kind: 'failed' };

export type SendOutcome =
  | { kind: 'sent' }
  | { kind: 'not_sent'; reason: 'new_only' | 'no_keys' } // nothing was to be put: the person chose «new records only» · this phone holds no key
  | { kind: 'unsupported' }
  | { kind: 'no_plan' } // the shell holds no press of the person's for this computer (not now · used up · too long ago)
  | { kind: 'cancelled' } // the person closed the phone's own confirmation
  | { kind: 'signed_out' }
  | { kind: 'unreachable' }
  | { kind: 'refused'; code: string } // the server's word on the put (the pairing is gone · remote control is off · a queue that is full …)
  | { kind: 'shell'; code: string }
  | { kind: 'failed' };

/** the shell does the handoff at all: `shell.caps` says `record_handoff: 1` (read, never guessed from a version) */
export async function shellTakesHandoff(phoneCall: Call): Promise<boolean> {
  return (await shellHandoffCaps(phoneCall)) === 'yes';
}
/** `yes` · `no` (the shell answered and does not do it — an older app) · `unknown` (the call failed or timed out: nothing is known, and nothing is concluded from it) */
export async function shellHandoffCaps(phoneCall: Call): Promise<'yes' | 'no' | 'unknown'> {
  const caps = await Promise.resolve().then(() => phoneCall('shell.caps', {})).catch(() => null);
  if (!caps) return 'unknown';
  if (caps.ok === true && isObj(caps.caps)) return (caps.caps as { record_handoff?: unknown }).record_handoff === 1 ? 'yes' : 'no';
  return caps.ok === false && caps.code === 'bad_request' ? 'no' : 'unknown'; // (an older shell refuses a type it does not know with `bad_request`; any other failure is a failure, not a «no»)
}

/** what a watch knows from one look to the next (the shell's capability and this phone's key id do not change within a watch) */
export interface TakeCache { caps?: 'yes'; phoneKeyId?: string }

/** the id the server lists THIS phone's key under (the key number the shell reads off the device, matched to the person's devices) */
async function ownPhoneKeyId(phoneCall: Call): Promise<{ kind: 'id'; id: string } | { kind: 'no_phone' } | { kind: 'signed_out' } | { kind: 'unreachable' } | { kind: 'failed' }> {
  let key: PhoneAnswer;
  try { key = await phoneCall('device.key.info', {}); } catch { return { kind: 'failed' }; }
  if (!key || key.ok !== true || typeof key.key_number !== 'string') return { kind: 'failed' };
  let res: Response;
  try { res = await fetchWithAuth('/api/remote-devices'); } catch { return { kind: 'unreachable' }; }
  if (res.status === 401) return { kind: 'signed_out' };
  if (!res.ok) return { kind: res.status >= 500 ? 'unreachable' : 'failed' };
  try {
    const body = (await res.json()) as { devices?: Array<{ id?: unknown; confirm_number?: unknown }> };
    if (!Array.isArray(body.devices)) return { kind: 'failed' };
    const mine = body.devices.find((d) => d && d.confirm_number === key.key_number && typeof d.id === 'string' && UUID.test(d.id));
    return mine ? { kind: 'id', id: mine.id as string } : { kind: 'no_phone' };
  } catch { return { kind: 'failed' }; }
}

async function codeOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { code?: string }; detail?: { code?: string }; code?: string };
    return body.error?.code ?? body.detail?.code ?? body.code ?? '';
  } catch { return ''; }
}

/** one look at what computers put for this phone: hand it to the shell, tell the server the rows the shell TOOK */
export async function takeHandoffs(o: { phoneCall: Call; cache?: TakeCache }): Promise<TakeOutcome> {
  if (o.cache?.caps !== 'yes') {
    const caps = await shellHandoffCaps(o.phoneCall);
    if (caps === 'no') return { kind: 'unsupported' };
    if (caps === 'unknown') return { kind: 'failed' }; // a transient failure is not «this shell cannot»: the watch tries again
    if (o.cache) o.cache.caps = 'yes';
  }
  const own: Awaited<ReturnType<typeof ownPhoneKeyId>> = o.cache?.phoneKeyId ? { kind: 'id', id: o.cache.phoneKeyId } : await ownPhoneKeyId(o.phoneCall);
  if (own.kind !== 'id') return own;
  if (o.cache) o.cache.phoneKeyId = own.id;
  let res: Response;
  try { res = await fetchWithAuth(`/api/desktop/record-handoffs?phone_key_id=${encodeURIComponent(own.id)}`); } catch { return { kind: 'unreachable' }; }
  if (res.status === 401) return { kind: 'signed_out' };
  if (res.status >= 500) return { kind: 'unreachable' };
  if (!res.ok) return { kind: 'failed' };
  let items: Array<{ id: string; setup_id: string; envelope: Record<string, unknown> }>;
  try {
    const body = (await res.json()) as { items?: unknown };
    if (!Array.isArray(body.items) || body.items.length > HANDOFF_PAGE) return { kind: 'failed' };
    items = [];
    for (const r of body.items) {
      // only the three fields the shell is promised go on (a field the server adds is not the shell's business)
      if (!isObj(r) || typeof r.id !== 'string' || !UUID.test(r.id) || typeof r.setup_id !== 'string' || !UUID.test(r.setup_id) || !isObj(r.envelope)) return { kind: 'failed' };
      items.push({ id: r.id, setup_id: r.setup_id, envelope: r.envelope });
    }
  } catch { return { kind: 'failed' }; }
  if (items.length === 0) return { kind: 'done', seen: 0, taken: 0, later: 0, rejected: 0, acked: 0 };
  let ans: PhoneAnswer;
  try { ans = await o.phoneCall('handoff.take', { items }); } catch { return { kind: 'failed' }; }
  if (!ans || ans.ok !== true) {
    const code = ans && typeof ans.code === 'string' ? ans.code : '';
    if (code === 'signed_out') return { kind: 'signed_out' };
    if (code === 'bad_request') return { kind: 'unsupported' }; // (an older shell's bridge refuses the type as it refuses anything it does not know)
    return code ? { kind: 'shell', code } : { kind: 'failed' };
  }
  // exactly the ids the shell said it TOOK — and only ones that were asked (a word outside the page is not a row of ours)
  const asked = new Set(items.map((i) => i.id));
  const taken = Array.isArray(ans.taken) ? (ans.taken as unknown[]).filter((x): x is string => typeof x === 'string' && asked.has(x)) : [];
  const num = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : Array.isArray(v) ? v.length : 0);
  let acked = 0;
  for (const id of new Set(taken)) {
    try {
      const r = await fetchWithAuth(`/api/desktop/record-handoffs/${encodeURIComponent(id)}/received?phone_key_id=${encodeURIComponent(own.id)}`, { method: 'POST' });
      if (r.ok) acked++; // (a failed one is simply asked again at the next look: the shell answers «taken» again for a row it already took)
    } catch { /* the next look */ }
  }
  return { kind: 'done', seen: items.length, taken: new Set(taken).size, later: num(ans.later), rejected: num(ans.rejected), acked };
}

/** after this phone paired with the computer of `setupId`: the shell makes the envelope the person's choice calls for (or says there is none), and it is put */
/** the waits before the put is tried again with the SAME envelope (a network that dropped, a server that answered 5xx): the server holds a put once (the envelope's own id), so a repeat is harmless; the envelope lives 5 minutes */
export const PUT_RETRY_WAITS_MS: readonly number[] = [2_000, 5_000, 15_000];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function sendHandoff(o: { phoneCall: Call; setupId: string; retryWaitsMs?: readonly number[] }): Promise<SendOutcome> {
  if (!UUID.test(o.setupId)) return { kind: 'failed' };
  const caps = await shellHandoffCaps(o.phoneCall);
  if (caps === 'no') return { kind: 'unsupported' };
  if (caps === 'unknown') return { kind: 'failed' };
  let ans: PhoneAnswer;
  try { ans = await o.phoneCall('handoff.make', { setup_id: o.setupId }); } catch { return { kind: 'failed' }; }
  if (!ans) return { kind: 'failed' };
  if (ans.ok !== true) {
    const code = typeof ans.code === 'string' ? ans.code : '';
    if (code === 'no_plan') return { kind: 'no_plan' };
    if (code === 'cancelled') return { kind: 'cancelled' };
    if (code === 'signed_out') return { kind: 'signed_out' };
    if (code === 'bad_request') return { kind: 'unsupported' };
    return code ? { kind: 'shell', code } : { kind: 'failed' };
  }
  if (ans.sent !== true) return { kind: 'not_sent', reason: ans.reason === 'new_only' ? 'new_only' : 'no_keys' };
  if (typeof ans.phone_key_id !== 'string' || !UUID.test(ans.phone_key_id) || !isObj(ans.envelope)) return { kind: 'failed' };
  const url = `/api/desktop/setups/${encodeURIComponent(o.setupId)}/record-handoffs/${encodeURIComponent(ans.phone_key_id)}`;
  const body = JSON.stringify({ envelope: ans.envelope });
  const waits = o.retryWaitsMs ?? PUT_RETRY_WAITS_MS;
  // the envelope is sealed ONCE (one OS prompt); a put that did not get through is repeated with the same bytes — never sealed again
  for (let attempt = 0; ; attempt++) {
    let res: Response | null = null;
    try { res = await fetchWithAuth(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body }); } catch { res = null; }
    if (res && res.ok) return { kind: 'sent' };
    if (res && res.status === 401) return { kind: 'signed_out' };
    if (res && res.status < 500 && res.status !== 429) return { kind: 'refused', code: (await codeOf(res)) || `http_${res.status}` };
    if (attempt >= waits.length) return { kind: 'unreachable' }; // (a network that dropped · a 5xx · a 429, still there after the last wait)
    await sleep(waits[attempt]!);
  }
}
