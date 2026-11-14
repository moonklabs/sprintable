// @vitest-environment jsdom
//
// story 4940 — `useSubmitLatch`: one press = one request · a success that leaves the page keeps the button locked until the page is left · a failure releases at once · a navigation that never happens does not lock anyone for good.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SUBMIT_HOLD_FALLBACK_MS, useSubmitLatch } from './use-submit-latch';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Latch = ReturnType<typeof useSubmitLatch>;
let latch: Latch; let isLoading = false; let rendered = 0;
function Probe({ ms }: { ms?: number }) {
  const [loading, setLoading] = useState(false);
  latch = useSubmitLatch(setLoading, ms);
  isLoading = loading; rendered += 1;
  return <span>{loading ? 'loading' : 'idle'}</span>;
}

let host: HTMLDivElement; let root: Root | null;
beforeEach(() => { vi.useFakeTimers(); host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); rendered = 0; });
afterEach(async () => { await act(async () => { root?.unmount(); }); host.remove(); vi.useRealTimers(); });
const mount = async (ms?: number) => { await act(async () => { root!.render(<Probe ms={ms} />); }); };

describe('useSubmitLatch', () => {
  it('⭐one press = one request: a second enter() while the first is going gets false — even in the same frame, before the state has rendered', async () => {
    await mount();
    let first = false; let second = false;
    await act(async () => { first = latch.enter(); second = latch.enter(); });
    expect([first, second]).toEqual([true, false]);
    expect(isLoading).toBe(true);
  });
  it('a failure road (no hold) is released at once by exit(), and the next press may enter', async () => {
    await mount();
    await act(async () => { latch.enter(); });
    await act(async () => { latch.exit(); });
    expect(isLoading).toBe(false);
    let again = false; await act(async () => { again = latch.enter(); });
    expect(again).toBe(true);
  });
  it('⭐a success road (hold) stays locked through the finally — exit() releases nothing — and a press in that window is refused', async () => {
    await mount();
    await act(async () => { latch.enter(); latch.hold(); latch.exit(); });
    expect(isLoading).toBe(true);
    let again = true; await act(async () => { again = latch.enter(); });
    expect(again).toBe(false);
    await act(async () => { vi.advanceTimersByTime(SUBMIT_HOLD_FALLBACK_MS - 1); });
    expect(isLoading).toBe(true);
  });
  it('⭐a navigation that never happens lets go after the fallback — the button is not locked for good, and the next press may enter', async () => {
    await mount();
    await act(async () => { latch.enter(); latch.hold(); latch.exit(); });
    await act(async () => { vi.advanceTimersByTime(SUBMIT_HOLD_FALLBACK_MS); });
    expect(isLoading).toBe(false);
    let again = false; await act(async () => { again = latch.enter(); });
    expect(again).toBe(true);
  });
  it('the fallback is the caller\'s to choose (fallbackMs)', async () => {
    await mount(500);
    await act(async () => { latch.enter(); latch.hold(); latch.exit(); });
    await act(async () => { vi.advanceTimersByTime(499); });
    expect(isLoading).toBe(true);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(isLoading).toBe(false);
  });
  it('the page being left (unmount) clears the fallback: no state is set on a gone page', async () => {
    await mount();
    await act(async () => { latch.enter(); latch.hold(); latch.exit(); });
    expect(vi.getTimerCount()).toBe(1); // the fallback is waiting
    const before = rendered;
    await act(async () => { root!.unmount(); root = null; });
    expect(vi.getTimerCount(), 'the page is gone: no fallback is left waiting').toBe(0);
    await act(async () => { vi.advanceTimersByTime(SUBMIT_HOLD_FALLBACK_MS * 2); });
    expect(rendered).toBe(before);
  });
  it('a new attempt after a held one was released starts clean (hold does not leak into the next road)', async () => {
    await mount();
    await act(async () => { latch.enter(); latch.hold(); latch.exit(); });
    await act(async () => { vi.advanceTimersByTime(SUBMIT_HOLD_FALLBACK_MS); });
    await act(async () => { latch.enter(); latch.exit(); }); // this one fails: no hold
    expect(isLoading).toBe(false);
  });
});
