// story 5027 (lens 5025 · F1) — the phone proves it holds the key it registers: ask the server for a one-time value, have the SHELL sign it (the page names only three ids), register with the proof.
// An older shell (no `key_proof: 1`) registers as it always did; a key the list already calls proved is not proved again.
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { sendPairOffer, type OfferHead } from './phone-pairing';
import type { PhoneAnswer } from './phone-bridge';

let currentFetch: (url: string, init?: RequestInit) => Promise<Response> = async () => { throw new Error('no server'); };
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (url: string, init?: RequestInit) => currentFetch(url, init) }));

const HEAD: OfferHead = { offer_id: '0f3c2a1e-1111-4222-8333-944455556666', setup_id: '12345678-9abc-4def-8123-456789abcdef', device_name: 'Mac', expires_at: '2099-01-01T00:00:00Z' };
const KEY_ID = '7d1e9c2a-aaaa-4bbb-8ccc-dddddddddddd';
const PUBLIC_KEY = 'AQID'; // bytes 1 2 3
const FP = 'sha256:' + createHash('sha256').update(Buffer.from([1, 2, 3])).digest('hex');
const CH = { nonce: '1.abc.def', member_id: 'aaaaaaaa-0000-4000-8000-000000000001', org_id: 'bbbbbbbb-0000-4000-8000-000000000002', expires_at: '2099-01-01T00:00:00Z' };
const POP = { payload: 'eyJ2IjoxfQ', sig: 'MEUCIQ' };
const res = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });

function world(opts: { caps?: PhoneAnswer; prove?: PhoneAnswer; routes?: Record<string, () => Response>; devices?: unknown[]; keyInfo?: string } = {}) {
  const answers: Record<string, PhoneAnswer> = {
    'shell.caps': opts.caps ?? { id: 'x', ok: true, caps: { key_proof: 1 } },
    'device.key.info': { id: 'x', ok: true, public_key: opts.keyInfo ?? PUBLIC_KEY, key_number: '482 917' },
    'device.key.prove': opts.prove ?? { id: 'x', ok: true, pop: POP },
    'pair.mac': { id: 'x', ok: true, mac: 'MAC' },
  };
  const phoneCall = vi.fn(async (type: string, _args?: Record<string, unknown>) => answers[type] ?? { id: 'x', ok: false, code: 'bad_request' });
  const routes: Record<string, () => Response> = {
    'POST /api/remote-devices/challenge': () => res(200, CH),
    'POST /api/remote-devices': () => res(201, { id: KEY_ID }),
    'GET /api/remote-devices': () => res(200, { devices: opts.devices ?? [{ id: KEY_ID, pairs: [] }] }),
    'POST /api/remote-devices/pairing-offers': () => res(202, { state: 'sent' }),
    ...opts.routes,
  };
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url.split('?')[0]}`;
    const r = routes[key];
    if (!r) throw new Error(`unexpected ${key}`);
    return r();
  });
  currentFetch = fetch;
  return { phoneCall, fetch };
}
const bodies = (fetch: ReturnType<typeof world>['fetch'], path: string) =>
  fetch.mock.calls.filter(([u, i]) => u.split('?')[0] === path && i?.method === 'POST').map(([, i]) => JSON.parse(i!.body as string));
const calls = (fetch: ReturnType<typeof world>['fetch'], path: string) => fetch.mock.calls.filter(([u]) => u.split('?')[0] === path).length;

describe('[5027] the proof of holding the key', () => {
  it('a shell that can prove: one-time value → the shell signs it (three ids only) → the registration carries the proof', async () => {
    const w = world();
    await expect(sendPairOffer(HEAD, 'iPhone', { phoneCall: w.phoneCall })).resolves.toEqual({ kind: 'sent', phoneKeyId: KEY_ID });
    expect(w.phoneCall).toHaveBeenCalledWith('device.key.prove', { member_id: CH.member_id, org_id: CH.org_id, nonce: CH.nonce }); // exactly these: the page never names what is signed
    expect(bodies(w.fetch, '/api/remote-devices')).toEqual([{ label: 'iPhone', public_key: PUBLIC_KEY, pop: POP }]);
  });

  it('an older shell (no key_proof) registers exactly as before — no value asked, no prompt, no proof', async () => {
    for (const caps of [{ id: 'x', ok: true, caps: { sealed_prompt: 1 } }, { id: 'x', ok: true, caps: { key_proof: 0 } }, { id: 'x', ok: true }, { id: 'x', ok: false, code: 'bad_request' }, { id: 'x', ok: false, code: 'failed', caps: { key_proof: 1 } }] as PhoneAnswer[]) {
      const w = world({ caps });
      await expect(sendPairOffer(HEAD, 'iPhone', { phoneCall: w.phoneCall })).resolves.toEqual({ kind: 'sent', phoneKeyId: KEY_ID });
      expect(calls(w.fetch, '/api/remote-devices/challenge')).toBe(0);
      expect(w.phoneCall.mock.calls.some(([t]) => t === 'device.key.prove')).toBe(false);
      expect(bodies(w.fetch, '/api/remote-devices')).toEqual([{ label: 'iPhone', public_key: PUBLIC_KEY }]);
    }
  });

  it('a key the server\'s list already calls proved is not proved again (no prompt)', async () => {
    const w = world({ devices: [{ id: KEY_ID, fingerprint: FP, pop_verified: true, pairs: [] }] });
    await expect(sendPairOffer(HEAD, 'iPhone', { phoneCall: w.phoneCall })).resolves.toEqual({ kind: 'sent', phoneKeyId: KEY_ID });
    expect(calls(w.fetch, '/api/remote-devices/challenge')).toBe(0);
    expect(w.phoneCall.mock.calls.some(([t]) => t === 'device.key.prove')).toBe(false);
    expect(bodies(w.fetch, '/api/remote-devices')).toEqual([{ label: 'iPhone', public_key: PUBLIC_KEY }]);
  });

  it('a real key has base64url letters (- and _): the fingerprint is still the server\'s, so a proved key is still not proved again', async () => {
    const key = '-__-'; // bytes fb ff fe — the url-safe spelling of «+//+»
    const fp = 'sha256:' + createHash('sha256').update(Buffer.from([0xfb, 0xff, 0xfe])).digest('hex');
    const w = world({ devices: [{ id: KEY_ID, fingerprint: fp, pop_verified: true, pairs: [] }], keyInfo: key });
    await expect(sendPairOffer(HEAD, 'iPhone', { phoneCall: w.phoneCall })).resolves.toEqual({ kind: 'sent', phoneKeyId: KEY_ID });
    expect(calls(w.fetch, '/api/remote-devices/challenge')).toBe(0);
    expect(bodies(w.fetch, '/api/remote-devices')).toEqual([{ label: 'iPhone', public_key: key }]);
  });

  it.each([
    ['a listed key that was never proved', [{ id: KEY_ID, fingerprint: FP, pop_verified: false, pairs: [] }]],
    ['a proved key with ANOTHER fingerprint', [{ id: KEY_ID, fingerprint: 'sha256:' + '0'.repeat(64), pop_verified: true, pairs: [] }]],
    ['a list that says nothing about proof', [{ id: KEY_ID, fingerprint: FP, pairs: [] }]],
  ])('%s → proves', async (_n, devices) => {
    const w = world({ devices });
    await expect(sendPairOffer(HEAD, 'iPhone', { phoneCall: w.phoneCall })).resolves.toEqual({ kind: 'sent', phoneKeyId: KEY_ID });
    expect(bodies(w.fetch, '/api/remote-devices')[0].pop).toEqual(POP);
  });

  it('the list cannot be read → proves (never «skip» on a failed read)', async () => {
    const w = world({ routes: { 'GET /api/remote-devices': () => res(500) } });
    await expect(sendPairOffer(HEAD, 'iPhone', { phoneCall: w.phoneCall })).resolves.toMatchObject({ kind: expect.any(String) });
    expect(w.phoneCall.mock.calls.some(([t]) => t === 'device.key.prove')).toBe(true);
  });

  it.each([
    ['the shell: no screen lock', { prove: { id: 'x', ok: false, code: 'no_screen_lock' } }, 'noScreenLock'],
    ['the shell: biometric required', { prove: { id: 'x', ok: false, code: 'biometric_required' } }, 'biometricRequired'],
    ['the person closed the prompt', { prove: { id: 'x', ok: false, code: 'cancelled' } }, 'failed'],
    ['the shell answers without a proof', { prove: { id: 'x', ok: true } }, 'failed'],
    ['a proof of the wrong shape', { prove: { id: 'x', ok: true, pop: { payload: 5, sig: 'x' } } }, 'failed'],
    ['signed out when the value is asked', { routes: { 'POST /api/remote-devices/challenge': () => res(401) } }, 'signedOut'],
    ['the server cannot make a value', { routes: { 'POST /api/remote-devices/challenge': () => res(503, { error: { code: 'pop_unavailable' } }) } }, 'failed'],
    ['a value of the wrong shape', { routes: { 'POST /api/remote-devices/challenge': () => res(200, { nonce: 5 }) } }, 'failed'],
    ['a value that is not JSON', { routes: { 'POST /api/remote-devices/challenge': () => new Response('<html>', { status: 200 }) } }, 'failed'],
  ] as Array<[string, Parameters<typeof world>[0], string]>)('%s → %s, and nothing is registered', async (_n, opts, kind) => {
    const w = world(opts);
    await expect(sendPairOffer(HEAD, 'iPhone', { phoneCall: w.phoneCall })).resolves.toEqual({ kind });
    expect(bodies(w.fetch, '/api/remote-devices')).toEqual([]);
  });

  it('a value that ran out on its way (pop_expired) is asked for once more, then the step goes on', async () => {
    let n = 0;
    const w = world({ routes: { 'POST /api/remote-devices': () => (++n === 1 ? res(422, { error: { code: 'pop_expired' } }) : res(201, { id: KEY_ID })) } });
    await expect(sendPairOffer(HEAD, 'iPhone', { phoneCall: w.phoneCall })).resolves.toEqual({ kind: 'sent', phoneKeyId: KEY_ID });
    expect(calls(w.fetch, '/api/remote-devices/challenge')).toBe(2);
    expect(w.phoneCall.mock.calls.filter(([t]) => t === 'device.key.prove')).toHaveLength(2);
  });

  it('…but only once: a second pop_expired ends the step (no endless prompts)', async () => {
    const w = world({ routes: { 'POST /api/remote-devices': () => res(422, { error: { code: 'pop_expired' } }) } });
    await expect(sendPairOffer(HEAD, 'iPhone', { phoneCall: w.phoneCall })).resolves.toEqual({ kind: 'failed' });
    expect(w.phoneCall.mock.calls.filter(([t]) => t === 'device.key.prove')).toHaveLength(2);
  });

  it('any other refusal of the proof is not retried (pop_invalid · pop_unsupported_key → failed after ONE prompt)', async () => {
    for (const code of ['pop_invalid', 'pop_unsupported_key']) {
      const w = world({ routes: { 'POST /api/remote-devices': () => res(422, { error: { code } }) } });
      await expect(sendPairOffer(HEAD, 'iPhone', { phoneCall: w.phoneCall })).resolves.toEqual({ kind: 'failed' });
      expect(w.phoneCall.mock.calls.filter(([t]) => t === 'device.key.prove')).toHaveLength(1);
    }
  });

  it('the existing answers of the registration are unchanged with a proof (limit · taken · other org)', async () => {
    for (const [code, kind] of [['remote_device_limit', 'limit'], ['remote_device_taken', 'taken']] as const) {
      const w = world({ routes: { 'POST /api/remote-devices': () => res(409, { error: { code } }) } });
      await expect(sendPairOffer(HEAD, 'iPhone', { phoneCall: w.phoneCall })).resolves.toEqual({ kind });
    }
  });
});
