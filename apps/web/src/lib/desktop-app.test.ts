// story 4679 (UX-1 · D1): the desktop app's bridge as the web reads it — present and shaped → itself; a browser (no global), an
// odd shape (inApp not true · runtimes not the closed shape · a hand missing) → undefined, so every screen stays as it is.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetDesktopAppForTest, desktopApp, desktopAppOf, subscribeDesktopApp, type DesktopRuntimeFound, type SprintableDesktop } from './desktop-app';

const bridge = (): SprintableDesktop => ({
  inApp: true, device: { name: 'SYJ-MacBook-Pro' },
  runtimes: [{ runtime: 'claude', version: '2.1.288', executable: '/Users/me/.local/bin/claude' }, { runtime: 'codex', version: '0.159.3', executable: '/opt/homebrew/bin/codex' }],
  pickFolder: async () => '/Users/me/work', startHere: async () => ({ ok: true }), setProjectFolder: async () => ({ ok: true }),
});

describe('[SID:4679] desktopAppOf — the bridge only when its shape checks', () => {
  it('the app\'s bridge → itself (values and the three hands as given)', async () => {
    const b = bridge();
    const d = desktopAppOf(b);
    expect(d).toBe(b);
    expect(d?.device.name).toBe('SYJ-MacBook-Pro');
    expect(d?.runtimes.map((r) => [r.runtime, r.version])).toEqual([['claude', '2.1.288'], ['codex', '0.159.3']]);
    expect(await d?.pickFolder()).toBe('/Users/me/work');
    expect(await d?.startHere({ agentId: 'a1' })).toEqual({ ok: true });
    expect(await d?.setProjectFolder({ projectId: 'p1', path: '/Users/me/work' })).toEqual({ ok: true });
  });

  it('nothing · not an object · inApp not exactly true → undefined', () => {
    expect(desktopAppOf(undefined)).toBeUndefined();
    expect(desktopAppOf(null)).toBeUndefined();
    expect(desktopAppOf('yes')).toBeUndefined();
    expect(desktopAppOf({ ...bridge(), inApp: false })).toBeUndefined();
    expect(desktopAppOf({ ...bridge(), inApp: 'true' })).toBeUndefined();
  });

  it('a device without a name · runtimes not the closed shape (an unknown runtime · a missing field · not an array) → undefined', () => {
    expect(desktopAppOf({ ...bridge(), device: {} })).toBeUndefined();
    expect(desktopAppOf({ ...bridge(), runtimes: [{ runtime: 'gemini', version: '1', executable: '/x' }] })).toBeUndefined();
    expect(desktopAppOf({ ...bridge(), runtimes: [{ runtime: 'claude', version: '2.1.288' }] })).toBeUndefined();
    expect(desktopAppOf({ ...bridge(), runtimes: 'claude' })).toBeUndefined();
    expect(desktopAppOf({ ...bridge(), runtimes: [] })).toBeDefined(); // none found is a fine answer
  });

  it('a hand missing (an older app) → undefined — D2/D3 never call into a half bridge', () => {
    const { setProjectFolder: _drop, ...older } = bridge();
    expect(desktopAppOf(older)).toBeUndefined();
    expect(desktopAppOf({ ...bridge(), startHere: 'later' })).toBeUndefined();
  });
});

describe('[SID:4679 AC1] desktopApp() — the page in a browser has none', () => {
  const g = globalThis as unknown as { window?: unknown };
  const had = g.window;
  afterEach(() => { if (had === undefined) delete g.window; else g.window = had; });

  it('no window (the server) → undefined · a window without the global (a browser) → undefined · the app\'s window → the bridge', () => {
    delete g.window;
    expect(desktopApp()).toBeUndefined();
    g.window = {};
    expect(desktopApp()).toBeUndefined();
    const b = bridge();
    g.window = { sprintableDesktop: b };
    expect(desktopApp()).toBe(b);
  });
});

// ── story 4691: the app's list can change after the page loaded ─────────────────────────────────────────────────────────────────
const CLAUDE: DesktopRuntimeFound = { runtime: 'claude', version: '2.1.288', executable: '/Users/me/.local/bin/claude' };
const CODEX: DesktopRuntimeFound = { runtime: 'codex', version: '0.159.3', executable: '/opt/homebrew/bin/codex' };

/** a bridge as the app gives it with the fourth hand: `subscribeRuntimes` calls back RIGHT AWAY with its newest list, then on change */
function liveBridge(first: DesktopRuntimeFound[]) {
  let current = first;
  const callbacks = new Set<(r: readonly DesktopRuntimeFound[]) => void>();
  const unsubscribe = vi.fn();
  const subscribeRuntimes = vi.fn((cb: (r: readonly DesktopRuntimeFound[]) => void) => {
    callbacks.add(cb);
    cb(current); // the immediate replay
    return () => { unsubscribe(); callbacks.delete(cb); };
  });
  const b: SprintableDesktop = { ...bridge(), runtimes: first, subscribeRuntimes };
  return { b, subscribeRuntimes, unsubscribe, push: (next: DesktopRuntimeFound[]) => { current = next; for (const cb of [...callbacks]) cb(next); } };
}

describe('[SID:4691] the fourth hand `subscribeRuntimes` is optional, but a function when present', () => {
  it('an older app (none) → still the bridge · a function → the bridge · a non-function → undefined (a half bridge is never used)', () => {
    expect(desktopAppOf(bridge())).toBeDefined(); // reverted to a required hand → this fails
    expect(desktopAppOf({ ...bridge(), subscribeRuntimes: () => () => undefined })).toBeDefined();
    expect(desktopAppOf({ ...bridge(), subscribeRuntimes: 'later' })).toBeUndefined();
    expect(desktopAppOf({ ...bridge(), subscribeRuntimes: null })).toBeUndefined();
  });
});

describe('[SID:4691] subscribeDesktopApp · desktopApp() — a list that arrives after the page loaded', () => {
  const g = globalThis as unknown as { window?: unknown };
  const had = g.window;
  afterEach(() => { __resetDesktopAppForTest(); if (had === undefined) delete g.window; else g.window = had; });

  it('page loaded before detection (runtimes []): subscribing replays at once; the app then reports the list → the listener fires and desktopApp() answers with it', () => {
    const live = liveBridge([]);
    g.window = { sprintableDesktop: live.b };
    const listen = vi.fn();
    const off = subscribeDesktopApp(listen);
    expect(live.subscribeRuntimes).toHaveBeenCalledTimes(1);
    expect(listen).not.toHaveBeenCalled(); // the replay equals what the page already holds → no needless re-render
    expect(desktopApp()).toBe(live.b);

    live.push([CODEX, CLAUDE]);
    expect(listen).toHaveBeenCalledTimes(1); // reverted (no subscription) → 0
    const after = desktopApp()!;
    expect(after.runtimes).toEqual([CODEX, CLAUDE]); // the app's order
    expect(after.device.name).toBe('SYJ-MacBook-Pro'); // everything else as the app gave it
    expect(after.pickFolder).toBe(live.b.pickFolder);
    expect(desktopApp()).toBe(after); // the SAME list → the SAME object (useSyncExternalStore must not loop)
    off();
  });

  it('detection finished before the page subscribed: the immediate replay already carries the newest list', () => {
    const live = liveBridge([]); // the page read [] at load …
    g.window = { sprintableDesktop: live.b };
    live.push([CLAUDE]); // … detection ended before anyone subscribed (nobody to call yet)
    const listen = vi.fn();
    subscribeDesktopApp(listen);
    expect(listen).toHaveBeenCalledTimes(1); // the replay brought [claude]
    expect(desktopApp()!.runtimes).toEqual([CLAUDE]);
  });

  it('an unchanged list is not an event · a changed one is · going back to the load-time list returns the app\'s own object', () => {
    const live = liveBridge([CLAUDE]);
    g.window = { sprintableDesktop: live.b };
    const listen = vi.fn();
    subscribeDesktopApp(listen);
    live.push([{ ...CLAUDE }]); // same content
    expect(listen).not.toHaveBeenCalled();
    live.push([CLAUDE, CODEX]);
    expect(listen).toHaveBeenCalledTimes(1);
    live.push([CLAUDE]);
    expect(listen).toHaveBeenCalledTimes(2);
    expect(desktopApp()).toBe(live.b);
  });

  it('an answer off the closed shape is ignored — the page keeps what it has', () => {
    const live = liveBridge([CLAUDE]);
    g.window = { sprintableDesktop: live.b };
    const listen = vi.fn();
    subscribeDesktopApp(listen);
    (live.push as (n: unknown) => void)([{ runtime: 'gemini', version: '1', executable: '/x' }]);
    (live.push as (n: unknown) => void)('claude');
    expect(listen).not.toHaveBeenCalled();
    expect(desktopApp()!.runtimes).toEqual([CLAUDE]);
  });

  it('one subscription to the app for all listeners · released when the last one leaves', () => {
    const live = liveBridge([]);
    g.window = { sprintableDesktop: live.b };
    const a = vi.fn(); const b2 = vi.fn();
    const offA = subscribeDesktopApp(a);
    const offB = subscribeDesktopApp(b2);
    expect(live.subscribeRuntimes).toHaveBeenCalledTimes(1);
    live.push([CODEX]);
    expect([a.mock.calls.length, b2.mock.calls.length]).toEqual([1, 1]);
    offA();
    expect(live.unsubscribe).not.toHaveBeenCalled();
    offB();
    expect(live.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('a browser (no bridge) · an older app (no subscribeRuntimes) → a no-op: no call, no listener, the first read stays', () => {
    g.window = {};
    expect(() => subscribeDesktopApp(vi.fn())()).not.toThrow();
    const older = bridge();
    g.window = { sprintableDesktop: older };
    const listen = vi.fn();
    subscribeDesktopApp(listen)();
    expect(listen).not.toHaveBeenCalled();
    expect(desktopApp()).toBe(older);
    delete (g as { window?: unknown }).window; // the server
    expect(() => subscribeDesktopApp(vi.fn())()).not.toThrow();
  });
});
