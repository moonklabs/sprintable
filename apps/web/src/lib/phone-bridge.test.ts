// @vitest-environment jsdom
//
// story #4532 — the phone bridge claim (design doc 0dceadda v3.1 ②): claimed once at boot · the sender kept out of `window` ·
// answers matched by id, once · nothing outside the phone app.
import { afterEach, describe, expect, it } from 'vitest';
import { __resetPhoneBridgeForTest, claimPhoneBridge, isPhoneApp, phoneCall } from './phone-bridge';

/** what the shell puts into the top frame (sprintable-mobile lib/phoneBridge): one claim, then the handle is gone */
function installShellHandle() {
  const sent: Array<Record<string, unknown>> = [];
  let taken = false;
  window.__sprintablePhone = {
    claim() {
      if (taken) return null;
      taken = true;
      delete window.__sprintablePhone;
      return (m) => { sent.push({ ...m, bt: 'token', __phone: 1 }); };
    },
  };
  return sent;
}

afterEach(() => {
  __resetPhoneBridgeForTest();
  delete window.__sprintablePhone;
  delete window.__sprintablePhoneReply;
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
    window.__sprintablePhoneReply!({ id: 'someone-else', ok: true });
    window.__sprintablePhoneReply!({ id, ok: true, signed: 's' });
    await expect(p).resolves.toEqual({ id, ok: true, signed: 's' });
    // a second answer to the same id changes nothing (no one waits)
    expect(() => window.__sprintablePhoneReply!({ id, ok: false, code: 'late' })).not.toThrow();
  });

  it('two calls at once: each answer reaches its own call', async () => {
    const sent = installShellHandle();
    claimPhoneBridge();
    const a = phoneCall('device.key.info');
    const b = phoneCall('pair.scan');
    window.__sprintablePhoneReply!({ id: sent[1]!.id as string, ok: false, code: 'cancelled' });
    window.__sprintablePhoneReply!({ id: sent[0]!.id as string, ok: true, public_key: 'K' });
    await expect(a).resolves.toMatchObject({ ok: true, public_key: 'K' });
    await expect(b).resolves.toMatchObject({ ok: false, code: 'cancelled' });
  });
});
