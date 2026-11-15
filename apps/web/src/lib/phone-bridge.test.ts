// @vitest-environment jsdom
//
// story #4532 — the phone bridge claim (design doc 0dceadda v3.1 ②): claimed once at boot · the sender and the receiver kept out
// of `window` (PO 06:07Z ①) · answers matched by id, once · no call waits forever (PO 06:07Z ②) · nothing outside the phone app.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetPhoneBridgeForTest, claimPhoneBridge, isPhoneApp, LATE_CLAIM_EVERY_MS, LATE_CLAIM_MAX_MS, PHONE_CALL_MAX_MS, phoneCall, subscribePhoneApp, type PhoneAnswer } from './phone-bridge';

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

// story #4661 — a claim that comes after a reader has already looked must reach that reader (useSyncExternalStore)
describe('subscribePhoneApp (story #4661)', () => {
  it('the claim notifies the subscriber once, and an unsubscribed listener hears nothing', () => {
    const heard = vi.fn();
    const off = subscribePhoneApp(heard);
    expect(isPhoneApp()).toBe(false);
    installShellHandle();
    claimPhoneBridge();
    expect(isPhoneApp()).toBe(true);
    expect(heard).toHaveBeenCalledTimes(1);
    off();
    __resetPhoneBridgeForTest();
    installShellHandle();
    claimPhoneBridge();
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

// story 4964 — the shell's handle can land AFTER the page's first render (React Native WebView on Android evaluates the «before content»
// script from onPageStarted, not at document start). Before this, the claim looked once and the pairing screen read «open this in the phone app».
describe('a handle that comes late (story 4964)', () => {
  afterEach(() => { delete (window as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView; });
  const inRnWebView = () => { (window as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView = { postMessage: () => undefined }; };

  it('inside a React Native WebView: the first look finds nothing (not the phone app yet) — the handle that lands 300 ms later is taken, the readers are told once, and the call goes out', async () => {
    vi.useFakeTimers();
    inRnWebView();
    const heard = vi.fn();
    const off = subscribePhoneApp(heard);
    claimPhoneBridge();
    expect(isPhoneApp()).toBe(false); // the page's first render: no handle yet
    await vi.advanceTimersByTimeAsync(300);
    expect(isPhoneApp()).toBe(false);
    const sent = installShellHandle(); // the shell's script lands
    await vi.advanceTimersByTimeAsync(LATE_CLAIM_EVERY_MS);
    expect(isPhoneApp()).toBe(true);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0); // the look stops at the claim
    void phoneCall('pair.scan');
    expect(sent).toHaveLength(1);
    expect(window.__sprintablePhone).toBeUndefined(); // the handle is still gone after the claim
    off(); // the listener set outlives a reset
  });

  it('a root re-render that finds the handle before the look\'s next step takes it AND ends the look at once (no step fires after the claim)', async () => {
    vi.useFakeTimers();
    inRnWebView();
    claimPhoneBridge();
    expect(vi.getTimerCount()).toBe(1);
    installShellHandle(); // lands between two steps of the look
    claimPhoneBridge(); // the next render of the root claim
    expect(isPhoneApp()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('asking again while it looks starts no second look · a handle that never comes ends the look at the cap, and one after the cap is not taken', async () => {
    vi.useFakeTimers();
    inRnWebView();
    claimPhoneBridge();
    claimPhoneBridge();
    claimPhoneBridge();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(LATE_CLAIM_MAX_MS + LATE_CLAIM_EVERY_MS);
    expect(vi.getTimerCount()).toBe(0);
    installShellHandle();
    await vi.advanceTimersByTimeAsync(LATE_CLAIM_MAX_MS);
    expect(isPhoneApp()).toBe(false);
  });

  it('a step that runs late (a busy page) after the cap does not take a handle that came after the cap', async () => {
    vi.useFakeTimers();
    inRnWebView();
    claimPhoneBridge();
    installShellHandle();
    vi.setSystemTime(Date.now() + LATE_CLAIM_MAX_MS + 1_000); // the clock moved past the cap before the next step ran
    await vi.advanceTimersByTimeAsync(LATE_CLAIM_EVERY_MS);
    expect(isPhoneApp()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('outside a React Native WebView (a browser · the Mac app): nothing is scheduled, and a handle that appears later is not taken', async () => {
    vi.useFakeTimers();
    claimPhoneBridge();
    expect(vi.getTimerCount()).toBe(0);
    installShellHandle();
    await vi.advanceTimersByTimeAsync(LATE_CLAIM_MAX_MS * 2);
    expect(isPhoneApp()).toBe(false);
    expect((await phoneCall('device.key.info')).code).toBe('not_phone_app');
  });

  it('a reader that throws when told of the late claim: the claim stands, the look is over, and the reader\'s error is not swallowed', async () => {
    vi.useFakeTimers();
    inRnWebView();
    const off = subscribePhoneApp(() => { throw new Error('reader broke'); });
    try {
      claimPhoneBridge();
      installShellHandle();
      await expect(vi.advanceTimersByTimeAsync(LATE_CLAIM_EVERY_MS)).rejects.toThrow('reader broke');
      expect(isPhoneApp()).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally { off(); } // the listener set outlives a reset — nobody after this test may hear it
  });

  it('a late handle whose claim() throws ends the look at once — no interval left running, no error thrown out of the timer', async () => {
    vi.useFakeTimers();
    inRnWebView();
    claimPhoneBridge();
    let calls = 0;
    window.__sprintablePhone = { claim: () => { calls += 1; throw new Error('shell broke'); } };
    await vi.advanceTimersByTimeAsync(LATE_CLAIM_EVERY_MS * 3);
    expect(calls).toBe(1); // looked once · not again every step
    expect(vi.getTimerCount()).toBe(0);
    expect(isPhoneApp()).toBe(false);
  });

  it('a handle somebody else already took (claim answers nothing) ends quietly at the cap — no throw, never the phone app', async () => {
    vi.useFakeTimers();
    inRnWebView();
    window.__sprintablePhone = { claim: () => null };
    claimPhoneBridge();
    await vi.advanceTimersByTimeAsync(LATE_CLAIM_MAX_MS + LATE_CLAIM_EVERY_MS);
    expect(isPhoneApp()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
