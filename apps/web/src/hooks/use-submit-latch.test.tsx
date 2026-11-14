// @vitest-environment jsdom
//
// story 4940 — `useSubmitLatch`: one press = one request · a success that leaves the page keeps the button locked until the page is left · a failure releases at once · a navigation that never happens does not lock anyone for good.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SUBMIT_HOLD_FALLBACK_MS, useSubmitLatch } from './use-submit-latch';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Latch = ReturnType<typeof useSubmitLatch>;
// what the probe shows the test: written in an effect (never during render)
const seen: { latch: Latch | null; loading: boolean; renders: number } = { latch: null, loading: false, renders: 0 };
const latch = () => seen.latch!;
function Probe({ ms }: { ms?: number }) {
  const [loading, setLoading] = useState(false);
  const l = useSubmitLatch(setLoading, ms);
  useEffect(() => { seen.latch = l; seen.loading = loading; seen.renders += 1; });
  return <span>{loading ? 'loading' : 'idle'}</span>;
}

let host: HTMLDivElement; let root: Root | null;
beforeEach(() => { vi.useFakeTimers(); host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); seen.renders = 0; seen.loading = false; });
afterEach(async () => { await act(async () => { root?.unmount(); }); host.remove(); vi.useRealTimers(); });
const mount = async (ms?: number) => { await act(async () => { root!.render(<Probe ms={ms} />); }); };

describe('useSubmitLatch', () => {
  it('⭐one press = one request: a second enter() while the first is going gets false — even in the same frame, before the state has seen.renders', async () => {
    await mount();
    let first = false; let second = false;
    await act(async () => { first = latch().enter(); second = latch().enter(); });
    expect([first, second]).toEqual([true, false]);
    expect(seen.loading).toBe(true);
  });
  it('a failure road (no hold) is released at once by exit(), and the next press may enter', async () => {
    await mount();
    await act(async () => { latch().enter(); });
    await act(async () => { latch().exit(); });
    expect(seen.loading).toBe(false);
    let again = false; await act(async () => { again = latch().enter(); });
    expect(again).toBe(true);
  });
  it('⭐a success road (hold) stays locked through the finally — exit() releases nothing — and a press in that window is refused', async () => {
    await mount();
    await act(async () => { latch().enter(); latch().hold(); latch().exit(); });
    expect(seen.loading).toBe(true);
    let again = true; await act(async () => { again = latch().enter(); });
    expect(again).toBe(false);
    await act(async () => { vi.advanceTimersByTime(SUBMIT_HOLD_FALLBACK_MS - 1); });
    expect(seen.loading).toBe(true);
  });
  it('⭐a navigation that never happens lets go after the fallback — the button is not locked for good, and the next press may enter', async () => {
    await mount();
    await act(async () => { latch().enter(); latch().hold(); latch().exit(); });
    await act(async () => { vi.advanceTimersByTime(SUBMIT_HOLD_FALLBACK_MS); });
    expect(seen.loading).toBe(false);
    let again = false; await act(async () => { again = latch().enter(); });
    expect(again).toBe(true);
  });
  it('the fallback is the caller\'s to choose (fallbackMs)', async () => {
    await mount(500);
    await act(async () => { latch().enter(); latch().hold(); latch().exit(); });
    await act(async () => { vi.advanceTimersByTime(499); });
    expect(seen.loading).toBe(true);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(seen.loading).toBe(false);
  });
  it('the page being left (unmount) clears the fallback: no state is set on a gone page', async () => {
    await mount();
    await act(async () => { latch().enter(); latch().hold(); latch().exit(); });
    expect(vi.getTimerCount()).toBe(1); // the fallback is waiting
    const before = seen.renders;
    await act(async () => { root!.unmount(); root = null; });
    expect(vi.getTimerCount(), 'the page is gone: no fallback is left waiting').toBe(0);
    await act(async () => { vi.advanceTimersByTime(SUBMIT_HOLD_FALLBACK_MS * 2); });
    expect(seen.renders).toBe(before);
  });
  it('a new attempt after a held one was released starts clean (hold does not leak into the next road)', async () => {
    await mount();
    await act(async () => { latch().enter(); latch().hold(); latch().exit(); });
    await act(async () => { vi.advanceTimersByTime(SUBMIT_HOLD_FALLBACK_MS); });
    await act(async () => { latch().enter(); latch().exit(); }); // this one fails: no hold
    expect(seen.loading).toBe(false);
  });
  it('a road that held and THEN failed (the navigation threw) takes the hold back: its exit() releases at once and the fallback timer is gone', async () => {
    await mount();
    await act(async () => { latch().enter(); latch().hold(); });
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => { latch().unhold(); latch().exit(); });
    expect(seen.loading).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    let again = false; await act(async () => { again = latch().enter(); });
    expect(again).toBe(true);
  });
  it('an answer that comes AFTER the page was left cannot start a lock: hold() on a gone page makes no timer', async () => {
    await mount();
    const gone = latch();
    await act(async () => { gone.enter(); });
    await act(async () => { root!.unmount(); root = null; });
    gone.hold();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('one latch can serve a form with several roads: the setter receives plain booleans', async () => {
    const calls: boolean[] = [];
    function TwoRoads() { const l = useSubmitLatch((on) => { calls.push(on); }); useEffect(() => { seen.latch = l; }); return null; }
    await act(async () => { root!.render(<TwoRoads />); });
    await act(async () => { latch().enter(); latch().exit(); });
    expect(calls).toEqual([true, false]);
  });
});
