// story 4978 (C1b-phone) — the watch: one look at once, then every WATCH_EVERY_MS until the window ends; asking again only extends it; no phone / an older shell / a sign-out end it; stopping takes the timer away.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const takeHandoffs = vi.fn();
vi.mock('./phone-handoff', () => ({ takeHandoffs: (...a: unknown[]) => takeHandoffs(...a) }));
import { __handoffWatchForTest, AFTER_PAIRING_MS, ON_OPEN_MS, startHandoffWatch, stopHandoffWatch, WATCH_EVERY_MS, WATCH_SLOW_AFTER_MS, WATCH_SLOW_EVERY_MS, type WatchEnv } from './phone-handoff-watch';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function env() {
  let t = 1_000_000; const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const e: WatchEnv = { now: () => t, setTimer: (fn, ms) => { const h = { fn, ms, live: true }; timers.push(h); return h; }, clearTimer: (h) => { (h as { live: boolean }).live = false; } };
  return { e, timers, advance: (ms: number) => { t += ms; }, fire: async () => { const h = timers.filter((x) => x.live).pop(); if (h) { h.live = false; h.fn(); await flush(); } }, live: () => timers.filter((x) => x.live).length };
}
const call = (async () => ({ id: 'c', ok: true })) as never;

beforeEach(() => { takeHandoffs.mockReset().mockResolvedValue({ kind: 'done', seen: 0, taken: 0, later: 0, rejected: 0, acked: 0 }); stopHandoffWatch(); });

describe('the handoff watch', () => {
  it('looks at once, then again every WATCH_EVERY_MS until the window ends — and then no timer is left', async () => {
    const w = env(); startHandoffWatch({ phoneCall: call, forMs: 12_000, env: w.e }); await flush();
    expect(takeHandoffs).toHaveBeenCalledTimes(1); expect(w.live()).toBe(1); expect(w.timers[0]!.ms).toBe(WATCH_EVERY_MS);
    w.advance(WATCH_EVERY_MS); await w.fire(); expect(takeHandoffs).toHaveBeenCalledTimes(2);
    w.advance(WATCH_EVERY_MS); await w.fire(); expect(takeHandoffs).toHaveBeenCalledTimes(3);
    w.advance(WATCH_EVERY_MS); await w.fire(); expect(takeHandoffs).toHaveBeenCalledTimes(3); // 15 s > 12 s: the window ended
    expect(w.live()).toBe(0); expect(__handoffWatchForTest().running).toBe(false);
  });
  it('asking again EXTENDS the one watch (never two): the window is the later end, one look at a time', async () => {
    const w = env(); startHandoffWatch({ phoneCall: call, forMs: ON_OPEN_MS, env: w.e }); await flush();
    startHandoffWatch({ phoneCall: call, forMs: AFTER_PAIRING_MS, env: w.e }); await flush();
    expect(takeHandoffs).toHaveBeenCalledTimes(1); expect(w.live()).toBe(1); expect(__handoffWatchForTest().until).toBe(1_000_000 + AFTER_PAIRING_MS);
    startHandoffWatch({ phoneCall: call, forMs: 1_000, env: w.e }); expect(__handoffWatchForTest().until).toBe(1_000_000 + AFTER_PAIRING_MS); // a shorter ask never shortens it
  });
  it('an older shell · no phone key · a sign-out end the watch (asking again would change nothing); a failed or unreachable look is tried again', async () => {
    for (const kind of ['unsupported', 'no_phone', 'signed_out']) {
      takeHandoffs.mockReset().mockResolvedValue({ kind }); stopHandoffWatch();
      const w = env(); startHandoffWatch({ phoneCall: call, forMs: 60_000, env: w.e }); await flush();
      expect(takeHandoffs, kind).toHaveBeenCalledTimes(1); expect(w.live(), kind).toBe(0); expect(__handoffWatchForTest().running, kind).toBe(false);
    }
    for (const kind of ['failed', 'unreachable', 'shell']) {
      takeHandoffs.mockReset().mockResolvedValue({ kind }); stopHandoffWatch();
      const w = env(); startHandoffWatch({ phoneCall: call, forMs: 60_000, env: w.e }); await flush();
      expect(w.live(), kind).toBe(1);
    }
    takeHandoffs.mockReset().mockRejectedValue(new Error('boom')); stopHandoffWatch();
    const w = env(); startHandoffWatch({ phoneCall: call, forMs: 60_000, env: w.e }); await flush(); expect(w.live()).toBe(1); // a throw is a failed look, not the end of the watch
  });
  it('stopping takes the timer away and no look is made after it', async () => {
    const w = env(); startHandoffWatch({ phoneCall: call, forMs: 60_000, env: w.e }); await flush();
    expect(w.live()).toBe(1); stopHandoffWatch(); expect(w.live()).toBe(0); expect(__handoffWatchForTest().running).toBe(false);
    w.advance(WATCH_EVERY_MS); await w.fire(); expect(takeHandoffs).toHaveBeenCalledTimes(1);
  });
  it('a look still in flight when it is asked again is not doubled', async () => {
    let release!: () => void; takeHandoffs.mockReset().mockImplementation(() => new Promise((r) => { release = () => r({ kind: 'done', seen: 0, taken: 0, later: 0, rejected: 0, acked: 0 }); }));
    const w = env(); startHandoffWatch({ phoneCall: call, forMs: 60_000, env: w.e }); await flush();
    startHandoffWatch({ phoneCall: call, forMs: 60_000, env: w.e }); await flush(); expect(takeHandoffs).toHaveBeenCalledTimes(1);
    release(); await flush(); expect(w.live()).toBe(1);
  });
  it('a look that was in flight when the watch was stopped and started again finishes into the OLD run: it cannot end or double the new one', async () => {
    const releases: Array<(v: unknown) => void> = [];
    takeHandoffs.mockReset().mockImplementation(() => new Promise((r) => { releases.push(r); }));
    const w = env(); startHandoffWatch({ phoneCall: call, forMs: 60_000, env: w.e }); await flush();
    stopHandoffWatch(); startHandoffWatch({ phoneCall: call, forMs: 60_000, env: w.e }); await flush(); // (an unmount and a remount: the first look is still out)
    expect(takeHandoffs).toHaveBeenCalledTimes(2);
    releases[0]!({ kind: 'signed_out' }); await flush(); // the OLD look ends with a sign-out: it must not end the new run
    expect(__handoffWatchForTest().running).toBe(true);
    releases[1]!({ kind: 'done', seen: 0, taken: 0, later: 0, rejected: 0, acked: 0 }); await flush();
    expect(w.live()).toBe(1); // the new run goes on, once
  });
  it('the look is made less often after the first two minutes, and one cache lives for the whole run', async () => {
    const w = env(); startHandoffWatch({ phoneCall: call, forMs: 10 * 60_000, env: w.e }); await flush();
    const caches = new Set<unknown>((takeHandoffs.mock.calls as unknown as Array<[{ cache: unknown }]>).map((c) => c[0].cache));
    expect(w.timers.at(-1)!.ms).toBe(WATCH_EVERY_MS);
    w.advance(WATCH_SLOW_AFTER_MS); await w.fire(); caches.add((takeHandoffs.mock.calls.at(-1) as unknown as [{ cache: unknown }])[0].cache);
    expect(w.timers.at(-1)!.ms).toBe(WATCH_SLOW_EVERY_MS);
    expect(caches.size).toBe(1); expect([...caches][0]).toBeTruthy();
    stopHandoffWatch(); startHandoffWatch({ phoneCall: call, forMs: 60_000, env: w.e }); await flush();
    caches.add((takeHandoffs.mock.calls.at(-1) as unknown as [{ cache: unknown }])[0].cache); expect(caches.size).toBe(2); // a new run starts with a fresh cache
  });
});
