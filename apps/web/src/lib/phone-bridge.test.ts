// @vitest-environment jsdom
//
// story #4532 — the phone bridge claim (design doc 0dceadda v3.1 ②): claimed once at boot · the sender and the receiver kept out
// of `window` (PO 06:07Z ①) · answers matched by id, once · no call waits forever (PO 06:07Z ②) · nothing outside the phone app.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetPhoneBridgeForTest, claimPhoneBridge, isPhoneApp, PHONE_CALL_MAX_MS, phoneCall, type PhoneAnswer } from './phone-bridge';

/** what the shell puts into the top frame (sprintable-mobile lib/phoneBridge): one claim, then the handle is gone */
let shellReply: ((a: PhoneAnswer) => void) | null = null;
function installShellHandle() {
  const sent: Array<Record<string, unknown>> = [];
  let taken = false;
  window.__sprintablePhone = {
    claim(onReply) {
      if (taken) return null;
      taken = true;
      delete window.__sprintablePhone;
      shellReply = onReply; // the shell's door hands answers to this receiver (with its token) — the web keeps nothing on window
      return (m) => { sent.push({ ...m, bt: 'token', __phone: 1 }); };
    },
  };
  return sent;
}
const reply = (a: PhoneAnswer) => shellReply!(a);

afterEach(() => {
  __resetPhoneBridgeForTest();
  delete window.__sprintablePhone;
  shellReply = null;
  vi.useRealTimers();
});

describe('[4532] phone bridge', () => {
  it('outside the phone app: not the phone app · a call answers not_phone_app (no handle)', async () => {
    claimPhoneBridge();
    expect(isPhoneApp()).toBe(false);
    expect((await phoneCall('device.key.info')).code).toBe('not_phone_app');
  });

  it('claims the handle once — the handle is gone after (a later same-origin frame finds nothing) · the sender is not on window', () => {
    installShellHandle();
    claimPhoneBridge();
    expect(isPhoneApp()).toBe(true);
    expect(window.__sprintablePhone).toBeUndefined();
    expect(Object.values(window).some((v) => typeof v === 'function' && String(v).includes('__phone'))).toBe(false);
    expect(Object.keys(window).filter((k) => k.startsWith('__sprintablePhone'))).toEqual([]); // no reply door of the web's own
    expect(typeof shellReply).toBe('function'); // the receiver went to the shell at the claim
    claimPhoneBridge(); // idempotent
    expect(isPhoneApp()).toBe(true);
  });

  it('a call goes out in the closed shape and its answer comes back under the same id, once', async () => {
    const sent = installShellHandle();
    claimPhoneBridge();
    const p = phoneCall('approval.sign', { id: 'r-1', decision: 'allow' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ v: 1, type: 'approval.sign', args: { id: 'r-1', decision: 'allow' } });
    const id = sent[0]!.id as string;
    reply({ id: 'someone-else', ok: true });
    reply({ id, ok: true, signed: 's' });
    await expect(p).resolves.toEqual({ id, ok: true, signed: 's' });
    // a second answer to the same id changes nothing (no one waits)
    expect(() => reply({ id, ok: false, code: 'late' })).not.toThrow();
  });

  it('two calls at once: each answer reaches its own call', async () => {
    const sent = installShellHandle();
    claimPhoneBridge();
    const a = phoneCall('device.key.info');
    const b = phoneCall('pair.scan');
    reply({ id: sent[1]!.id as string, ok: false, code: 'cancelled' });
    reply({ id: sent[0]!.id as string, ok: true, public_key: 'K' });
    await expect(a).resolves.toMatchObject({ ok: true, public_key: 'K' });
    await expect(b).resolves.toMatchObject({ ok: false, code: 'cancelled' });
  });

  it('an answer that never comes ends the call as «timeout» after the signing window — a late one is dropped', async () => {
    vi.useFakeTimers();
    const sent = installShellHandle();
    claimPhoneBridge();
    const p = phoneCall('approval.sign', { id: 'r-1', decision: 'allow' });
    let done: PhoneAnswer | null = null;
    void p.then((a) => { done = a; });
    await vi.advanceTimersByTimeAsync(PHONE_CALL_MAX_MS - 1);
    expect(done).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toMatchObject({ ok: false, code: 'timeout' });
    expect(() => reply({ id: sent[0]!.id as string, ok: true, signed: 'late' })).not.toThrow();
    expect(done).toMatchObject({ code: 'timeout' }); // the late answer changed nothing
  });

  it('leaving the page ends every waiting call (a page restored from the cache does not stay «sending»)', async () => {
    installShellHandle();
    claimPhoneBridge();
    const a = phoneCall('approval.sign', { id: 'r-1', decision: 'allow' });
    const b = phoneCall('device.auth');
    window.dispatchEvent(new Event('pagehide'));
    await expect(a).resolves.toMatchObject({ ok: false, code: 'page_hidden' });
    await expect(b).resolves.toMatchObject({ ok: false, code: 'page_hidden' });
  });
});
