// @vitest-environment jsdom
//
// story 4964 — the pairing screen's «not in the phone app» line must not stick when the shell's handle lands after the first render
// (React Native WebView on Android hands the script over from onPageStarted). The root claim re-reads through the subscribed store.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { PhoneBridgeClaim } from '@/components/providers/phone-bridge-claim';
import { usePhoneBridge } from '@/components/providers/phone-bridge-context';
import { __resetPhoneBridgeForTest, LATE_CLAIM_EVERY_MS } from '@/lib/phone-bridge';

// story 4978 (C1b-phone): the record key handoff's WATCH is what the provider starts in the phone app — a stand-in here (its own file tests the watch)
const watch = vi.hoisted(() => ({ startHandoffWatch: vi.fn(), stopHandoffWatch: vi.fn() }));
vi.mock('@/lib/phone-handoff-watch', () => ({ startHandoffWatch: watch.startHandoffWatch, stopHandoffWatch: watch.stopHandoffWatch, ON_OPEN_MS: 60_000, AFTER_PAIRING_MS: 600_000 }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe() {
  const { inPhoneApp } = usePhoneBridge();
  return <p data-testid="state">{inPhoneApp ? 'in the phone app' : 'not in the phone app'}</p>;
}

afterEach(() => {
  watch.startHandoffWatch.mockClear(); watch.stopHandoffWatch.mockClear();
  __resetPhoneBridgeForTest();
  delete window.__sprintablePhone;
  delete (window as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView;
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('PhoneBridgeClaim with a late handle (story 4964)', () => {
  it('the first render says «not in the phone app»; the handle lands 400 ms later and the screens flip to «in the phone app» by themselves', async () => {
    vi.useFakeTimers();
    (window as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView = { postMessage: () => undefined };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => { root.render(<PhoneBridgeClaim><Probe /></PhoneBridgeClaim>); });
    expect(host.textContent).toBe('not in the phone app');
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    let taken = false;
    window.__sprintablePhone = { claim: () => { taken = true; delete window.__sprintablePhone; return () => undefined; } };
    await act(async () => { await vi.advanceTimersByTimeAsync(LATE_CLAIM_EVERY_MS); });
    expect(taken).toBe(true);
    expect(host.textContent).toBe('in the phone app');
    await act(async () => { root.unmount(); });
  });

  it('outside the phone app the same late handle changes nothing', async () => {
    vi.useFakeTimers();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => { root.render(<PhoneBridgeClaim><Probe /></PhoneBridgeClaim>); });
    window.__sprintablePhone = { claim: () => () => undefined };
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(host.textContent).toBe('not in the phone app');
    await act(async () => { root.unmount(); });
  });
});

describe('PhoneBridgeClaim and the record key handoff watch (story 4978)', () => {
  const mount = async (withHandle: boolean) => {
    if (withHandle) window.__sprintablePhone = { claim: () => { delete window.__sprintablePhone; return () => undefined; } };
    const host = document.createElement('div'); document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => { root.render(<PhoneBridgeClaim><Probe /></PhoneBridgeClaim>); });
    return root;
  };
  it('in the phone app: one look when it opens (a short window), another each time the page comes back to the front, none while hidden — and unmounting ends the watch', async () => {
    const root = await mount(true);
    expect(watch.startHandoffWatch).toHaveBeenCalledTimes(1);
    expect((watch.startHandoffWatch.mock.calls[0] as unknown as [{ forMs: number }])[0].forMs).toBe(60_000);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(watch.startHandoffWatch).toHaveBeenCalledTimes(1); // hidden: no look
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(watch.startHandoffWatch).toHaveBeenCalledTimes(2);
    await act(async () => { root.unmount(); });
    expect(watch.stopHandoffWatch).toHaveBeenCalled();
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(watch.startHandoffWatch).toHaveBeenCalledTimes(2); // the listener went with the provider
  });
  it('outside the phone app nothing is looked for', async () => {
    const root = await mount(false);
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(watch.startHandoffWatch).not.toHaveBeenCalled();
    await act(async () => { root.unmount(); });
  });
});
