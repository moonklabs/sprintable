// story #4532 — every way an answer from the phone app ends maps to one outcome (design doc 0dceadda v3.1 ① · contract 02d2cf71 §9 ③).
import { describe, expect, it, vi } from 'vitest';
import { answerOnPhone, openOnPhone } from './phone-answer';
import type { PhoneAnswer } from './phone-bridge';

// the libs call fetchWithAuth (the codebase's one way to the BFF); each case hands its server here
let currentFetch: (url: string, init?: RequestInit) => Promise<Response> = async () => { throw new Error('no server'); };
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (url: string, init?: RequestInit) => currentFetch(url, init) }));
const serverFor = <P,>(phoneCall: P, fetch: (url: string, init?: RequestInit) => Promise<Response>) => { currentFetch = fetch; return { phoneCall }; };

const signedOk: PhoneAnswer = { id: 'w1', ok: true, signed: 'SIGNED', phone_key_id: 'k-1' };
const call = (answer: PhoneAnswer) => vi.fn(async () => answer);
const reply = (status: number, body?: unknown) =>
  vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status }));

describe('[4532] answerOnPhone', () => {
  it('asks the shell with {id, decision} only, then posts the shell\'s signed to the answer route', async () => {
    const phoneCall = call(signedOk);
    const fetch = reply(200, { ok: true });
    await expect(answerOnPhone('r-1', 'allow', serverFor(phoneCall, fetch))).resolves.toEqual({ kind: 'answered', decision: 'allow' });
    expect(phoneCall).toHaveBeenCalledWith('approval.sign', { id: 'r-1', decision: 'allow' });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/agent-permission-requests/r-1/answer');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ decision: 'allow', signed: 'SIGNED', phone_key_id: 'k-1' });
  });

  it.each([
    ['cancelled', 'cancelled'],
    ['biometric_required', 'biometric_required'],
    ['no_screen_lock', 'no_screen_lock'],
    ['key_invalidated', 'key_invalidated'],
    ['no_key', 'not_paired'], // [SID:4834] no key at all = never paired: «not paired», not «your lock settings changed · pair again»
    ['expired', 'expired'],
    ['not_pending', 'closed'],
    ['not_answerable', 'closed'],
    ['signed_out', 'signed_out'], // Kadir · PO 09:31Z ②: no session for the shell's read — its own line, never «already answered»
    ['not_registered', 'not_registered'], // PO 07:47Z ① · Yuna 07:58Z: a key the server does not know → its own line, pair again
    ['sign_failed', 'failed'],
    ['not_phone_app', 'failed'],
    ['timeout', 'failed'], // PO 06:07Z ②: no answer within the signing window — the buttons come back
    ['page_hidden', 'failed'],
  ])('the shell says %s → %s, and nothing is posted', async (code, kind) => {
    const fetch = reply(200);
    await expect(answerOnPhone('r-1', 'deny', serverFor(call({ id: 'w1', ok: false, code }), fetch))).resolves.toEqual({ kind });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a shell answer without signed or key id → failed, nothing posted', async () => {
    const fetch = reply(200);
    await expect(answerOnPhone('r-1', 'allow', serverFor(call({ id: 'w1', ok: true, signed: 'S' }), fetch))).resolves.toEqual({ kind: 'failed' });
    await expect(answerOnPhone('r-1', 'allow', serverFor(call({ id: 'w1', ok: true, phone_key_id: 'k' }), fetch))).resolves.toEqual({ kind: 'failed' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('server refusals map by code', async () => {
    const run = (status: number, body?: unknown) => answerOnPhone('r-1', 'allow', serverFor(call(signedOk), reply(status, body)));
    await expect(run(409, { error: { code: 'phone_not_paired' } })).resolves.toEqual({ kind: 'not_paired' });
    await expect(run(409, { error: { code: 'already_answered' }, detail: { answered_by_name: '선생님', decision: 'deny' } }))
      .resolves.toEqual({ kind: 'answered_by', name: '선생님', decision: 'deny' });
    await expect(run(409, { code: 'already_answered' })).resolves.toEqual({ kind: 'answered_by', name: null, decision: null });
    await expect(run(503, { error: { code: 'device_unreachable' } })).resolves.toEqual({ kind: 'unreachable' });
    await expect(run(410, { error: { code: 'expired' } })).resolves.toEqual({ kind: 'expired' });
    await expect(run(410)).resolves.toEqual({ kind: 'expired' }); // 410 with no body
    await expect(run(410, { error: { code: 'withdrawn' } })).resolves.toEqual({ kind: 'closed' });
    await expect(run(409, { error: { code: 'remote_control_off' } })).resolves.toEqual({ kind: 'closed' });
    await expect(run(400, { error: { code: 'bad_signature' } })).resolves.toEqual({ kind: 'failed' });
    await expect(run(500)).resolves.toEqual({ kind: 'failed' });
  });

  it('a network throw → failed (the request is left as it was)', async () => {
    const fetch = vi.fn(async () => { throw new TypeError('network'); });
    await expect(answerOnPhone('r-1', 'allow', serverFor(call(signedOk), fetch))).resolves.toEqual({ kind: 'failed' });
  });
});

describe('[4972] a sealed card is answered on the shell\'s own sheet', () => {
  it('posts the decision the shell SIGNED (its reply), not the call\'s stand-in', async () => {
    const phoneCall = call({ ...signedOk, decision: 'allow' });
    const fetch = reply(200, { ok: true });
    await expect(answerOnPhone('r-1', 'deny', serverFor(phoneCall, fetch), { sealed: true })).resolves.toEqual({ kind: 'answered', decision: 'allow' });
    expect(phoneCall).toHaveBeenCalledWith('approval.sign', { id: 'r-1', decision: 'deny' });
    expect(JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ decision: 'allow', signed: 'SIGNED', phone_key_id: 'k-1' });
  });

  it('a shell that does not say which decision it signed → failed, nothing posted (never an answer the person did not give)', async () => {
    const fetch = reply(200);
    await expect(answerOnPhone('r-1', 'deny', serverFor(call(signedOk), fetch), { sealed: true })).resolves.toEqual({ kind: 'failed' });
    await expect(answerOnPhone('r-1', 'deny', serverFor(call({ ...signedOk, decision: 'maybe' }), fetch), { sealed: true })).resolves.toEqual({ kind: 'failed' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('lens 5838 low 1 — a card the web did NOT call sealed: the shell\'s reply decision is the one posted when it says one; if it differs from the pressed one nothing is posted; an older shell (says nothing) keeps the pressed one', async () => {
    const fetch = reply(200, { ok: true });
    await expect(answerOnPhone('r-1', 'deny', serverFor(call({ ...signedOk, decision: 'deny' }), fetch))).resolves.toEqual({ kind: 'answered', decision: 'deny' });
    expect(JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).decision).toBe('deny');
    const f2 = reply(200);
    // the web thought it was plain but the shell signed another decision (the server told the two screens different things): nothing is posted
    await expect(answerOnPhone('r-1', 'deny', serverFor(call({ ...signedOk, decision: 'allow' }), f2))).resolves.toEqual({ kind: 'failed' });
    expect(f2).not.toHaveBeenCalled();
    // a reply that names something else is a broken shell
    await expect(answerOnPhone('r-1', 'deny', serverFor(call({ ...signedOk, decision: 'maybe' }), f2))).resolves.toEqual({ kind: 'failed' });
    expect(f2).not.toHaveBeenCalled();
    // an older shell says nothing: the pressed one, as always
    const f3 = reply(200, { ok: true });
    await expect(answerOnPhone('r-1', 'allow', serverFor(call(signedOk), f3))).resolves.toEqual({ kind: 'answered', decision: 'allow' });
    expect(JSON.parse((f3.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).decision).toBe('allow');
  });

  it('lens 807/5838 low 3 — the shell\'s vault_unavailable → not_ready · card_refused → cannot_open (own lines, nothing posted); openOnPhone says the same', async () => {
    const fetch = reply(200);
    await expect(answerOnPhone('r-1', 'allow', serverFor(call({ id: 'w1', ok: false, code: 'vault_unavailable' }), fetch))).resolves.toEqual({ kind: 'not_ready' });
    await expect(answerOnPhone('r-1', 'allow', serverFor(call({ id: 'w1', ok: false, code: 'card_refused' }), fetch), { sealed: true })).resolves.toEqual({ kind: 'cannot_open' });
    expect(fetch).not.toHaveBeenCalled();
    await expect(openOnPhone('r-1', { phoneCall: call({ id: 'w1', ok: false, code: 'vault_unavailable' }) })).resolves.toEqual({ kind: 'not_ready' });
    await expect(openOnPhone('r-1', { phoneCall: call({ id: 'w1', ok: false, code: 'card_refused' }) })).resolves.toEqual({ kind: 'cannot_open' });
  });

  it('openOnPhone: approval.view {id} — ok → opened · not_pending / not_answerable → closed · else failed', async () => {
    const phoneCall = call({ id: 'w1', ok: true });
    await expect(openOnPhone('r-1', { phoneCall })).resolves.toEqual({ kind: 'opened' });
    expect(phoneCall).toHaveBeenCalledWith('approval.view', { id: 'r-1' });
    await expect(openOnPhone('r-1', { phoneCall: call({ id: 'w1', ok: false, code: 'not_pending' }) })).resolves.toEqual({ kind: 'closed' });
    await expect(openOnPhone('r-1', { phoneCall: call({ id: 'w1', ok: false, code: 'timeout' }) })).resolves.toEqual({ kind: 'failed' });
    await expect(openOnPhone('r-1', { phoneCall: call({ id: 'w1', ok: false, code: 'not_phone_app' }) })).resolves.toEqual({ kind: 'failed' });
  });
});
