// story 4972 — the NEW pairing's steps through the web (design ② §5-2): each shell · server answer maps to one outcome; the web carries only public messages (the commitment · the nonce · the reveal) and never sees the QR's secret or a key of the computer.
import { describe, expect, it, vi } from 'vitest';
import { cancelPairSession, closePairSession, comparePairSession, finishPairSession, lookPaired, lookPairSession, revealPairSession, scanPairQr, sendPairCommit, type OfferHead } from './phone-pairing';
import type { PhoneAnswer } from './phone-bridge';

let currentFetch: (url: string, init?: RequestInit) => Promise<Response> = async () => { throw new Error('no server'); };
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (url: string, init?: RequestInit) => currentFetch(url, init) }));
const setServer = (f: (url: string, init?: RequestInit) => Promise<Response>) => { currentFetch = f; };

const HEAD: OfferHead = { offer_id: '0f3c2a1e-1111-4222-8333-944455556666', setup_id: '12345678-9abc-4def-8123-456789abcdef', device_name: 'My Mac', expires_at: '2099-01-01T00:00:00Z', version: 2 };
const KEY_ID = '7d1e9c2a-aaaa-4bbb-8ccc-dddddddddddd';
const res = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });
const shell = (answers: Record<string, PhoneAnswer>) => vi.fn(async (type: string) => answers[type] ?? { id: 'x', ok: false, code: 'bad_request' });
const okKey: PhoneAnswer = { id: 'x', ok: true, public_key: 'SPKI', key_number: '482 917' };
const REVEAL = { phone_spki: 'S', phone_box_pub: 'B', n_p: 'P', label: 'iPhone', binding_sig: 'G' };

function server(routes: Record<string, () => Response>) {
  const calls: Array<{ key: string; body: unknown }> = [];
  setServer(async (url, init) => {
    const key = `${init?.method ?? 'GET'} ${url.split('?')[0]}`;
    calls.push({ key, body: init?.body ? JSON.parse(init.body as string) : undefined });
    const r = routes[key];
    if (!r) throw new Error(`unexpected ${key}`);
    return r();
  });
  return calls;
}

describe('[4972] the scan says the version', () => {
  it('a v2 head carries version 2 · an old head stays exactly as it was (no version field)', async () => {
    await expect(scanPairQr({ phoneCall: shell({ 'pair.scan': { id: 'x', ok: true, ...HEAD } }) })).resolves.toEqual({ kind: 'confirm', head: HEAD });
    const { version: _v, ...old } = HEAD; void _v;
    await expect(scanPairQr({ phoneCall: shell({ 'pair.scan': { id: 'x', ok: true, ...old } }) })).resolves.toEqual({ kind: 'confirm', head: old });
    // any other version number the shell might say is not a v2
    await expect(scanPairQr({ phoneCall: shell({ 'pair.scan': { id: 'x', ok: true, ...old, version: 3 } }) })).resolves.toEqual({ kind: 'confirm', head: old });
  });
});

describe('[4972] sendPairCommit', () => {
  const okShell = () => shell({ 'device.key.info': okKey, 'pair.commit': { id: 'x', ok: true, commit: 'C'.repeat(43) } });
  const routes = (commit: () => Response) => ({
    'GET /api/remote-devices/pairing-target': () => res(404, {}),
    'POST /api/remote-devices': () => res(201, { id: KEY_ID }),
    'GET /api/remote-devices': () => res(200, { devices: [{ id: KEY_ID, pairs: [] }] }),
    [`POST /api/remote-devices/pairing-sessions/${HEAD.offer_id}/commit`]: commit,
  });

  it('registers the key, asks the shell for the commitment (offer + label only), posts it with the key id — and nothing else of the shell\'s', async () => {
    const calls = server(routes(() => res(202, { state: 'committed' })));
    const phoneCall = okShell();
    await expect(sendPairCommit(HEAD, 'iPhone', { phoneCall })).resolves.toEqual({ kind: 'sent', phoneKeyId: KEY_ID });
    expect(phoneCall).toHaveBeenCalledWith('pair.commit', { offer_id: HEAD.offer_id, label: 'iPhone' });
    expect(calls.at(-1)!.body).toEqual({ setup_id: HEAD.setup_id, phone_key_id: KEY_ID, commit: 'C'.repeat(43) });
  });
  it.each([
    ['offer_burned', 'offerUsed'], ['offer_expired', 'expired'], ['offer_not_found', 'offerGone'], ['remote_control_off', 'remoteOff'], ['device_unreachable', 'unreachable'],
    ['setup_not_found', 'setupNotFound'], ['phone_key_not_found', 'registerAgain'], ['something_else', 'failed'],
  ])('the server says %s → %s', async (code, kind) => {
    server(routes(() => res(409, { error: { code } })));
    await expect(sendPairCommit(HEAD, 'iPhone', { phoneCall: okShell() })).resolves.toEqual({ kind });
  });
  it('the shell\'s refusals: vault_unavailable → notReady · no_offer → expired · other → failed — and nothing is posted', async () => {
    const calls = server(routes(() => res(202, {})));
    for (const [code, kind] of [['vault_unavailable', 'notReady'], ['no_offer', 'expired'], ['busy', 'failed']] as const) {
      const phoneCall = shell({ 'device.key.info': okKey, 'pair.commit': { id: 'x', ok: false, code } });
      await expect(sendPairCommit(HEAD, 'iPhone', { phoneCall })).resolves.toEqual({ kind });
    }
    expect(calls.some((c) => c.key.endsWith('/commit'))).toBe(false);
  });
  it('the key step ends as it did before: no screen lock · already paired (nothing asked of the shell)', async () => {
    server(routes(() => res(202, {})));
    await expect(sendPairCommit(HEAD, 'iPhone', { phoneCall: shell({ 'device.key.info': { id: 'x', ok: false, code: 'no_screen_lock' } }) })).resolves.toEqual({ kind: 'noScreenLock' });
    const routes2 = { ...routes(() => res(202, {})), 'GET /api/remote-devices': () => res(200, { devices: [{ id: KEY_ID, pairs: [{ setup_id: HEAD.setup_id }] }] }) };
    server(routes2);
    const phoneCall = okShell();
    await expect(sendPairCommit(HEAD, 'iPhone', { phoneCall })).resolves.toEqual({ kind: 'alreadyPaired' });
    expect(phoneCall).not.toHaveBeenCalledWith('pair.commit', expect.anything());
  });
});

describe('[4972] lookPairSession', () => {
  const url = `GET /api/remote-devices/pairing-sessions/${HEAD.offer_id}`;
  it.each([
    [{ state: 'committed', n_m: null, sig: null }, { kind: 'waiting' }],
    [{ state: 'nonce', n_m: 'N', sig: 'S' }, { kind: 'nonce', n_m: 'N', sig: 'S' }],
    [{ state: 'revealed', n_m: 'N', sig: 'S' }, { kind: 'revealed' }], // already revealed (an answer was lost on the way back): the shell holds the number — go on to its window
    [{ state: 'burned', n_m: null, sig: null }, { kind: 'ended' }],
    [{ state: 'expired', n_m: null, sig: null }, { kind: 'ended' }],
    [{ state: 'nonce', n_m: null, sig: null }, { kind: 'failed' }],
    [{ state: 'nope' }, { kind: 'failed' }],
  ])('%j → %j', async (body, out) => {
    server({ [url]: () => res(200, body) });
    await expect(lookPairSession(HEAD)).resolves.toEqual(out);
  });
  it('a failed read is failed', async () => {
    server({ [url]: () => res(404, {}) });
    await expect(lookPairSession(HEAD)).resolves.toEqual({ kind: 'failed' });
  });
});

describe('[4972] a bridge that rejects ends the step (the screen is never left waiting on a call that is gone)', () => {
  const boom = vi.fn(async () => { throw new Error('bridge gone'); });
  it('commit · reveal · compare each end as a plain failure', async () => {
    server({
      'GET /api/remote-devices/pairing-target': () => res(404, {}), 'POST /api/remote-devices': () => res(201, { id: KEY_ID }), 'GET /api/remote-devices': () => res(200, { devices: [{ id: KEY_ID, pairs: [] }] }),
    });
    const flaky = vi.fn(async (type: string) => { if (type === 'device.key.info') return okKey; throw new Error('bridge gone'); });
    await expect(sendPairCommit(HEAD, 'iPhone', { phoneCall: flaky })).resolves.toEqual({ kind: 'failed' });
    // the scan and the key step are shared by both procedures: a bridge that rejects there ends as a plain failure too (the screen never stays on «busy»)
    await expect(scanPairQr({ phoneCall: boom })).resolves.toEqual({ kind: 'failed' });
    await expect(sendPairCommit(HEAD, 'iPhone', { phoneCall: boom })).resolves.toEqual({ kind: 'failed' });
    await expect(revealPairSession(HEAD, { n_m: 'N', sig: 'S' }, { phoneCall: boom })).resolves.toEqual({ kind: 'failed' });
    await expect(comparePairSession(HEAD, { phoneCall: boom })).resolves.toEqual({ kind: 'failed' });
  });
});

describe('[4972] revealPairSession', () => {
  const post = `POST /api/remote-devices/pairing-sessions/${HEAD.offer_id}/reveal`;
  const NONCE = { n_m: 'N'.repeat(22), sig: 'S'.repeat(70) };
  const okReveal: PhoneAnswer = { id: 'x', ok: true, reveal: REVEAL };
  it('the nonce goes to the shell, the shell\'s reveal fields (and only them) to the server — the web gets no number to draw', async () => {
    const calls = server({ [post]: () => res(202, { state: 'revealed' }) });
    const phoneCall = shell({ 'pair.reveal': okReveal });
    await expect(revealPairSession(HEAD, NONCE, { phoneCall })).resolves.toEqual({ kind: 'revealed' });
    expect(phoneCall).toHaveBeenCalledWith('pair.reveal', { offer_id: HEAD.offer_id, ...NONCE });
    expect(calls.at(-1)!.body).toEqual({ setup_id: HEAD.setup_id, ...REVEAL });
  });
  it.each([
    ['cancelled', 'cancelled'], ['bad_nonce', 'integrity'], ['no_offer', 'expired'], ['no_screen_lock', 'noScreenLock'], ['biometric_required', 'biometricRequired'], ['busy', 'failed'], ['sign_failed', 'failed'],
  ])('the shell says %s → %s (nothing posted)', async (code, kind) => {
    const calls = server({ [post]: () => res(202, {}) });
    await expect(revealPairSession(HEAD, NONCE, { phoneCall: shell({ 'pair.reveal': { id: 'x', ok: false, code } }) })).resolves.toEqual({ kind });
    expect(calls).toEqual([]);
  });
  it('a reveal that is missing a field is failed (nothing posted)', async () => {
    const calls = server({ [post]: () => res(202, {}) });
    await expect(revealPairSession(HEAD, NONCE, { phoneCall: shell({ 'pair.reveal': { id: 'x', ok: true, reveal: { ...REVEAL, binding_sig: undefined } } }) })).resolves.toEqual({ kind: 'failed' });
    await expect(revealPairSession(HEAD, NONCE, { phoneCall: shell({ 'pair.reveal': { id: 'x', ok: true } }) })).resolves.toEqual({ kind: 'failed' });
    expect(calls).toEqual([]);
  });
  it('the server\'s refusals: offer_burned → ended · offer_expired → expired · other → failed', async () => {
    for (const [code, kind] of [['offer_burned', 'ended'], ['offer_expired', 'expired'], ['no_nonce', 'failed']] as const) {
      server({ [post]: () => res(409, { error: { code } }) });
      await expect(revealPairSession(HEAD, NONCE, { phoneCall: shell({ 'pair.reveal': okReveal }) })).resolves.toEqual({ kind });
    }
  });
});

describe('[4972] comparePairSession · closePairSession · lookPaired', () => {
  it('the web only asks the shell to open its own window (the offer id and nothing it could press) — [같아요] in that window → agreed (a PROVISIONAL pin in the shell), nothing said to the server', async () => {
    const calls = server({});
    const ok = shell({ 'pair.compare': { id: 'x', ok: true, agreed: true } });
    await expect(comparePairSession(HEAD, { phoneCall: ok })).resolves.toEqual({ kind: 'agreed' });
    expect(ok).toHaveBeenCalledWith('pair.compare', { offer_id: HEAD.offer_id });
    expect(calls).toEqual([]); // the pin is the shell's, the computer's own [같아요] is the other half
  });
  it.each([['cancelled', 'closed'], ['vault_unavailable', 'notReady'], ['busy', 'busy'], ['no_offer', 'expired'], ['expired', 'expired'], ['bad_request', 'failed']])('the shell says %s → %s (nothing said to the server)', async (code, kind) => {
    const calls = server({});
    await expect(comparePairSession(HEAD, { phoneCall: shell({ 'pair.compare': { id: 'x', ok: false, code } }) })).resolves.toEqual({ kind });
    expect(calls).toEqual([]);
  });
  it('[달라요] in the shell\'s window → declined, AND the server is told to end the offer', async () => {
    const calls = server({ [`POST /api/remote-devices/pairing-sessions/${HEAD.offer_id}/close`]: () => res(200, { state: 'burned' }) });
    await expect(comparePairSession(HEAD, { phoneCall: shell({ 'pair.compare': { id: 'x', ok: true, agreed: false } }) })).resolves.toEqual({ kind: 'declined' });
    expect(calls.at(-1)).toEqual({ key: `POST /api/remote-devices/pairing-sessions/${HEAD.offer_id}/close`, body: { setup_id: HEAD.setup_id } });
  });
  it('closePairSession never throws', async () => {
    setServer(async () => { throw new Error('offline'); });
    await expect(closePairSession(HEAD)).resolves.toBeUndefined();
  });
  it('lookPaired: the server\'s list says whether the computer pinned this phone too', async () => {
    server({ 'GET /api/remote-devices': () => res(200, { devices: [{ id: KEY_ID, pairs: [{ setup_id: HEAD.setup_id }] }] }) });
    await expect(lookPaired(HEAD, KEY_ID)).resolves.toBe('paired');
    await expect(lookPaired(HEAD, 'other-key')).resolves.toBe('waiting');
    server({ 'GET /api/remote-devices': () => res(200, { devices: [{ id: KEY_ID, pairs: [{ setup_id: 'another-setup' }] }] }) });
    await expect(lookPaired(HEAD, KEY_ID)).resolves.toBe('waiting');
  });
});

describe('[4972] lens 5842 — the provisional pin: finish · cancel · the guards and the words', () => {
  it('finishPairSession: the shell makes its pin real (it reads the server\'s list itself) · not yet → waiting · each refusal has its word', async () => {
    const ok = shell({ 'pair.finish': { id: 'x', ok: true, pinned: true } });
    await expect(finishPairSession(HEAD, { phoneCall: ok })).resolves.toEqual({ kind: 'pinned' });
    expect(ok).toHaveBeenCalledWith('pair.finish', { offer_id: HEAD.offer_id }); // the offer id and nothing the page could say
    for (const [code, kind] of [['not_confirmed', 'waiting'], ['busy', 'waiting'], ['no_offer', 'expired'], ['expired', 'expired'], ['vault_unavailable', 'notReady'], ['host_already_pinned', 'alreadyPaired'], ['signed_out', 'signedOut'], ['failed', 'failed'], ['bad_request', 'failed']] as const) {
      await expect(finishPairSession(HEAD, { phoneCall: shell({ 'pair.finish': { id: 'x', ok: false, code } }) }), code).resolves.toEqual({ kind });
    }
    await expect(finishPairSession(HEAD, { phoneCall: shell({ 'pair.finish': { id: 'x', ok: true } }) })).resolves.toEqual({ kind: 'failed' }); // an answer that does not say «pinned»
    await expect(finishPairSession(HEAD, { phoneCall: vi.fn(async () => { throw new Error('gone'); }) })).resolves.toEqual({ kind: 'failed' });
  });
  it('cancelPairSession: the shell drops the offer AND the server\'s offer ends — never throws', async () => {
    const calls = server({ [`POST /api/remote-devices/pairing-sessions/${HEAD.offer_id}/close`]: () => res(200, { state: 'burned' }) });
    const phoneCall = shell({ 'pair.cancel': { id: 'x', ok: true } });
    await cancelPairSession(HEAD, { phoneCall });
    expect(phoneCall).toHaveBeenCalledWith('pair.cancel', { offer_id: HEAD.offer_id }); expect(calls.at(-1)!.key).toBe(`POST /api/remote-devices/pairing-sessions/${HEAD.offer_id}/close`);
    setServer(async () => { throw new Error('offline'); });
    await expect(cancelPairSession(HEAD, { phoneCall: vi.fn(async () => { throw new Error('gone'); }) })).resolves.toEqual({ pinning: false });
  });
  it('the commitment: «already started» and «a real pin stands» are their own words · a person who left while it was being made sends nothing', async () => {
    const routes = {
      'GET /api/remote-devices/pairing-target': () => res(404, {}), 'POST /api/remote-devices': () => res(201, { id: KEY_ID }), 'GET /api/remote-devices': () => res(200, { devices: [{ id: KEY_ID, pairs: [] }] }),
      [`POST /api/remote-devices/pairing-sessions/${HEAD.offer_id}/commit`]: () => res(202, { state: 'committed' }),
    };
    const calls = server(routes);
    for (const [code, kind] of [['already_committed', 'startedAlready'], ['host_already_pinned', 'alreadyPaired'], ['no_offer', 'expired']] as const) {
      await expect(sendPairCommit(HEAD, 'iPhone', { phoneCall: shell({ 'device.key.info': okKey, 'pair.commit': { id: 'x', ok: false, code } }) }), code).resolves.toEqual({ kind });
    }
    // left (alive false) while the shell was making the commitment: nothing goes to the server
    let alive = true;
    const slow = vi.fn(async (type: string) => { if (type === 'pair.commit') alive = false; return type === 'device.key.info' ? okKey : { id: 'x', ok: true, commit: 'C'.repeat(43) }; });
    await expect(sendPairCommit(HEAD, 'iPhone', { phoneCall: slow, alive: () => alive })).resolves.toEqual({ kind: 'failed' });
    expect(calls.some((c) => c.key.endsWith('/commit'))).toBe(false);
  });
  it('lens 816: the shell\'s own refusals at the commitment have words — an old line on the list (the computer holds this phone) · signed out · key not registered · no screen lock', async () => {
    const routes = {
      'GET /api/remote-devices/pairing-target': () => res(404, {}), 'POST /api/remote-devices': () => res(201, { id: KEY_ID }), 'GET /api/remote-devices': () => res(200, { devices: [{ id: KEY_ID, pairs: [] }] }),
    };
    server(routes);
    for (const [code, kind] of [['host_already_paired', 'computerHolds'], ['signed_out', 'signedOut'], ['not_registered', 'registerAgain'], ['no_key', 'registerAgain'], ['no_screen_lock', 'noScreenLock'], ['biometric_required', 'biometricRequired']] as const) {
      await expect(sendPairCommit(HEAD, 'iPhone', { phoneCall: shell({ 'device.key.info': okKey, 'pair.commit': { id: 'x', ok: false, code } }) }), code).resolves.toEqual({ kind });
    }
  });
  it('lens 816: cancelPairSession tells the page when the shell is writing the real pin (pinning) — and then the server\'s offer is NOT closed', async () => {
    const calls = server({ [`POST /api/remote-devices/pairing-sessions/${HEAD.offer_id}/close`]: () => res(200, { state: 'burned' }) });
    await expect(cancelPairSession(HEAD, { phoneCall: shell({ 'pair.cancel': { id: 'x', ok: true, pinning: true } }) })).resolves.toEqual({ pinning: true });
    expect(calls).toEqual([]);
    await expect(cancelPairSession(HEAD, { phoneCall: shell({ 'pair.cancel': { id: 'x', ok: true } }) })).resolves.toEqual({ pinning: false });
    expect(calls.at(-1)!.key).toBe(`POST /api/remote-devices/pairing-sessions/${HEAD.offer_id}/close`);
    await expect(cancelPairSession(HEAD, { phoneCall: vi.fn(async () => { throw new Error('gone'); }) })).resolves.toEqual({ pinning: false });
  });
  it('lookPairSession says WHY a read failed: signed out (401/403) · remote control off · anything else is just «read again»', async () => {
    const url = `GET /api/remote-devices/pairing-sessions/${HEAD.offer_id}`;
    for (const [status, body, why] of [[401, {}, 'signedOut'], [403, {}, 'signedOut'], [409, { error: { code: 'remote_control_off' } }, 'remoteOff'], [500, {}, undefined], [404, { error: { code: 'offer_not_found' } }, undefined]] as const) {
      server({ [url]: () => res(status, body) });
      await expect(lookPairSession(HEAD), String(status)).resolves.toEqual(why ? { kind: 'failed', why } : { kind: 'failed' });
    }
  });
});
