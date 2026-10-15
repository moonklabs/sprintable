// story #4532 — the pairing steps inside the phone app: each server · shell answer maps to one outcome (명세 b0713c54 폰 표 ·
// contract 02d2cf71 §10 ① ⑤ v1.11). The web never sees the QR's secret: only the head goes past the shell.
import { describe, expect, it, vi } from 'vitest';
import { checkPairOffer, phoneLabel, scanPairQr, sendPairOffer, type OfferHead } from './phone-pairing';
import type { PhoneAnswer } from './phone-bridge';

// the libs call fetchWithAuth (the codebase's one way to the BFF); each case hands its server here
let currentFetch: (url: string, init?: RequestInit) => Promise<Response> = async () => { throw new Error('no server'); };
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (url: string, init?: RequestInit) => currentFetch(url, init) }));
const serverFor = <P,>(phoneCall: P, fetch: (url: string, init?: RequestInit) => Promise<Response>) => { currentFetch = fetch; return { phoneCall }; };

const HEAD: OfferHead = {
  offer_id: '0f3c2a1e-1111-4222-8333-944455556666', setup_id: '12345678-9abc-4def-8123-456789abcdef',
  device_name: 'SYJ-MacBook-Pro', expires_at: '2099-01-01T00:00:00Z',
};
const KEY_ID = '7d1e9c2a-aaaa-4bbb-8ccc-dddddddddddd';
const res = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });

/** a shell that answers each call type from a table */
function shell(answers: Record<string, PhoneAnswer>) {
  return vi.fn(async (type: string) => answers[type] ?? { id: 'x', ok: false, code: 'bad_request' });
}
/** a server that answers by method + path */
function server(routes: Record<string, () => Response>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url.split('?')[0]}`;
    const r = routes[key];
    if (!r) throw new Error(`unexpected ${key}`);
    return r();
  });
}

describe('[4532] phoneLabel', () => {
  it('names the phone from its web view', () => {
    expect(phoneLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe('iPhone');
    expect(phoneLabel('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)')).toBe('iPad');
    expect(phoneLabel('Mozilla/5.0 (Linux; Android 15; SM-S938N Build/AP3A.240905.015.A2; wv) AppleWebKit/537.36')).toBe('SM-S938N');
    expect(phoneLabel('Mozilla/5.0 (Linux; Android 15; SM-S938N) AppleWebKit/537.36')).toBe('SM-S938N');
    expect(phoneLabel('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36')).toBe('Android'); // reduced UA
  });
});

describe('[4532] scanPairQr', () => {
  it('passes the head only on to the screen', async () => {
    const phoneCall = shell({ 'pair.scan': { id: 'x', ok: true, ...HEAD } });
    await expect(scanPairQr(serverFor(phoneCall, server({})))).resolves.toEqual({ kind: 'confirm', head: HEAD });
  });
  it.each([['cancelled', 'cancelled'], ['expired', 'expired'], ['not_ours', 'notOurs'], ['bad', 'notOurs'], ['failed', 'failed']])(
    'the shell says %s → %s', async (code, kind) => {
      await expect(scanPairQr(serverFor(shell({ 'pair.scan': { id: 'x', ok: false, code } }), server({})))).resolves.toEqual({ kind });
    });
  it('a head with a missing field → failed', async () => {
    const phoneCall = shell({ 'pair.scan': { id: 'x', ok: true, offer_id: HEAD.offer_id } });
    await expect(scanPairQr(serverFor(phoneCall, server({})))).resolves.toEqual({ kind: 'failed' });
  });
});

describe('[4532] sendPairOffer', () => {
  const okShell = () => shell({
    'device.key.info': { id: 'x', ok: true, public_key: 'SPKI', key_number: '482 917' },
    'pair.mac': { id: 'x', ok: true, mac: 'MAC' },
  });
  const okRoutes = (over: Record<string, () => Response> = {}) => ({
    'POST /api/remote-devices': () => res(201, { id: KEY_ID }),
    'GET /api/remote-devices': () => res(200, { devices: [{ id: KEY_ID, pairs: [] }] }),
    'POST /api/remote-devices/pairing-offers': () => res(202, { state: 'sent' }),
    ...over,
  });

  it('registers the key, asks the shell for the MAC over the QR setup, and offers it', async () => {
    const phoneCall = okShell();
    const fetch = server(okRoutes());
    await expect(sendPairOffer(HEAD, 'SM-S938N', serverFor(phoneCall, fetch))).resolves.toEqual({ kind: 'sent', phoneKeyId: KEY_ID });
    const posts = fetch.mock.calls.filter(([, i]) => i?.method === 'POST').map(([u, i]) => [u, JSON.parse(i!.body as string)]);
    expect(posts).toEqual([
      ['/api/remote-devices', { label: 'SM-S938N', public_key: 'SPKI' }],
      ['/api/remote-devices/pairing-offers', { setup_id: HEAD.setup_id, offer_id: HEAD.offer_id, phone_key_id: KEY_ID, label: 'SM-S938N', expires_at: HEAD.expires_at, mac: 'MAC' }],
    ]);
    expect(phoneCall).toHaveBeenCalledWith('pair.mac', { offer_id: HEAD.offer_id, phone_key_id: KEY_ID, label: 'SM-S938N' });
  });

  it('this phone already paired with that computer → alreadyPaired, nothing offered', async () => {
    const phoneCall = okShell();
    const fetch = server(okRoutes({ 'GET /api/remote-devices': () => res(200, { devices: [{ id: KEY_ID, pairs: [{ setup_id: HEAD.setup_id }] }] }) }));
    await expect(sendPairOffer(HEAD, 'x', serverFor(phoneCall, fetch))).resolves.toEqual({ kind: 'alreadyPaired' });
    expect(phoneCall).not.toHaveBeenCalledWith('pair.mac', expect.anything());
  });

  it('a phone that cannot confirm says why, before anything is registered', async () => {
    for (const [code, kind] of [['no_screen_lock', 'noScreenLock'], ['biometric_required', 'biometricRequired'], ['failed', 'failed']]) {
      const fetch = server({});
      await expect(sendPairOffer(HEAD, 'x', serverFor(shell({ 'device.key.info': { id: 'x', ok: false, code } }), fetch))).resolves.toEqual({ kind });
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it('the registration refused: three phones already → limit · another account\'s phone → taken (story #4624) · anything else → failed', async () => {
    await expect(sendPairOffer(HEAD, 'x', serverFor(okShell(), server(okRoutes({ 'POST /api/remote-devices': () => res(409, { error: { code: 'remote_device_limit' } }) })))))
      .resolves.toEqual({ kind: 'limit' });
    await expect(sendPairOffer(HEAD, 'x', serverFor(okShell(), server(okRoutes({ 'POST /api/remote-devices': () => res(409, { error: { code: 'remote_device_taken' } }) })))))
      .resolves.toEqual({ kind: 'taken' });
    await expect(sendPairOffer(HEAD, 'x', serverFor(okShell(), server(okRoutes({ 'POST /api/remote-devices': () => res(409, { error: { code: 'something_new' } }) })))))
      .resolves.toEqual({ kind: 'failed' });
  });

  it('the shell no longer holds the QR (used · passed) → expired', async () => {
    const phoneCall = shell({ 'device.key.info': { id: 'x', ok: true, public_key: 'SPKI' }, 'pair.mac': { id: 'x', ok: false, code: 'no_offer' } });
    await expect(sendPairOffer(HEAD, 'x', serverFor(phoneCall, server(okRoutes())))).resolves.toEqual({ kind: 'expired' });
  });

  it.each([
    ['offer_used', 409, 'offerUsed'], ['invalid_expiry', 422, 'expired'], ['remote_control_off', 409, 'remoteOff'],
    ['device_unreachable', 409, 'unreachable'], ['setup_not_found', 404, 'setupNotFound'], ['phone_key_not_found', 404, 'registerAgain'],
    ['person_session_required', 403, 'failed'],
  ])('the offer refused with %s → %s', async (code, status, kind) => {
    const fetch = server(okRoutes({ 'POST /api/remote-devices/pairing-offers': () => res(status as number, { error: { code } }) }));
    await expect(sendPairOffer(HEAD, 'x', serverFor(okShell(), fetch))).resolves.toEqual({ kind });
  });
});

describe('[4532] checkPairOffer', () => {
  const offerPath = `GET /api/remote-devices/pairing-offers/${HEAD.offer_id}`;
  const notYet = () => res(200, { devices: [{ id: KEY_ID, pairs: [] }] });
  const stood = () => res(200, { devices: [{ id: KEY_ID, pairs: [{ setup_id: HEAD.setup_id }] }] });

  it('sent → still waiting (the setup goes along in the query)', async () => {
    const fetch = server({ [offerPath]: () => res(200, { state: 'sent', reveal: null }) });
    await expect(checkPairOffer(HEAD, KEY_ID, null, serverFor(shell({}), fetch))).resolves.toEqual({ kind: 'waiting' });
    expect(fetch.mock.calls[0]![0]).toBe(`/api/remote-devices/pairing-offers/${HEAD.offer_id}?setup_id=${HEAD.setup_id}`);
  });

  it('revealed → the shell computes the number from its own key, once', async () => {
    const phoneCall = shell({ 'pair.number': { id: 'x', ok: true, number: '296 843' } });
    const fetch = server({ [offerPath]: () => res(200, { state: 'revealed', reveal: 'R' }), 'GET /api/remote-devices': notYet });
    await expect(checkPairOffer(HEAD, KEY_ID, null, serverFor(phoneCall, fetch))).resolves.toEqual({ kind: 'number', number: '296 843' });
    expect(phoneCall).toHaveBeenCalledWith('pair.number', { offer_id: HEAD.offer_id, reveal: 'R' });
    phoneCall.mockClear();
    await expect(checkPairOffer(HEAD, KEY_ID, '296 843', serverFor(phoneCall, fetch))).resolves.toEqual({ kind: 'number', number: '296 843' });
    expect(phoneCall).not.toHaveBeenCalled();
  });

  it('the pair stood on the computer → paired (also when the offer reads expired after)', async () => {
    for (const state of ['revealed', 'expired']) {
      const fetch = server({ [offerPath]: () => res(200, { state, reveal: 'R' }), 'GET /api/remote-devices': stood });
      await expect(checkPairOffer(HEAD, KEY_ID, '296 843', serverFor(shell({}), fetch))).resolves.toEqual({ kind: 'paired' });
    }
  });

  it('expired with no pair → notPaired; a broken answer → failed', async () => {
    await expect(checkPairOffer(HEAD, KEY_ID, null, serverFor(shell({}), server({ [offerPath]: () => res(200, { state: 'expired' }), 'GET /api/remote-devices': notYet }))))
      .resolves.toEqual({ kind: 'notPaired' });
    await expect(checkPairOffer(HEAD, KEY_ID, null, serverFor(shell({}), server({ [offerPath]: () => res(404, { error: { code: 'offer_not_found' } }) }))))
      .resolves.toEqual({ kind: 'failed' });
    await expect(checkPairOffer(HEAD, KEY_ID, null, serverFor(shell({}), server({ [offerPath]: () => res(200, { state: 'revealed', reveal: null }), 'GET /api/remote-devices': notYet }))))
      .resolves.toEqual({ kind: 'failed' });
  });
});
