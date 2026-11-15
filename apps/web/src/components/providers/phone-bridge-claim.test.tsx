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

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe() {
  const { inPhoneApp } = usePhoneBridge();
  return <p data-testid="state">{inPhoneApp ? 'in the phone app' : 'not in the phone app'}</p>;
}

afterEach(() => {
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
