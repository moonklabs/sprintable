// story #4532 — every way an answer from the phone app ends maps to one outcome (design doc 0dceadda v3.1 ① · contract 02d2cf71 §9 ③).
import { describe, expect, it, vi } from 'vitest';
import { answerOnPhone } from './phone-answer';
import type { PhoneAnswer } from './phone-bridge';

const signedOk: PhoneAnswer = { id: 'w1', ok: true, signed: 'SIGNED', phone_key_id: 'k-1' };
const call = (answer: PhoneAnswer) => vi.fn(async () => answer);
const reply = (status: number, body?: unknown) =>
  vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status }));

describe('[4532] answerOnPhone', () => {
  it('asks the shell with {id, decision} only, then posts the shell\'s signed to the answer route', async () => {
    const phoneCall = call(signedOk);
    const fetch = reply(200, { ok: true });
    await expect(answerOnPhone('r-1', 'allow', { phoneCall, fetch })).resolves.toEqual({ kind: 'answered', decision: 'allow' });
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
    ['key_invalidated', 'key_invalidated'],
    ['expired', 'expired'],
    ['not_pending', 'closed'],
    ['not_answerable', 'closed'],
    ['not_registered', 'failed'],
    ['sign_failed', 'failed'],
    ['not_phone_app', 'failed'],
  ])('the shell says %s → %s, and nothing is posted', async (code, kind) => {
    const fetch = reply(200);
    await expect(answerOnPhone('r-1', 'deny', { phoneCall: call({ id: 'w1', ok: false, code }), fetch })).resolves.toEqual({ kind });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a shell answer without signed or key id → failed, nothing posted', async () => {
    const fetch = reply(200);
    await expect(answerOnPhone('r-1', 'allow', { phoneCall: call({ id: 'w1', ok: true, signed: 'S' }), fetch })).resolves.toEqual({ kind: 'failed' });
    await expect(answerOnPhone('r-1', 'allow', { phoneCall: call({ id: 'w1', ok: true, phone_key_id: 'k' }), fetch })).resolves.toEqual({ kind: 'failed' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('server refusals map by code', async () => {
    const run = (status: number, body?: unknown) => answerOnPhone('r-1', 'allow', { phoneCall: call(signedOk), fetch: reply(status, body) });
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
    await expect(answerOnPhone('r-1', 'allow', { phoneCall: call(signedOk), fetch })).resolves.toEqual({ kind: 'failed' });
  });
});
