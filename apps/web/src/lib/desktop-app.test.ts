// story 4679 (UX-1 · D1): the desktop app's bridge as the web reads it — present and shaped → itself; a browser (no global), an
// odd shape (inApp not true · runtimes not the closed shape · a hand missing) → undefined, so every screen stays as it is.
import { afterEach, describe, expect, it } from 'vitest';
import { desktopApp, desktopAppOf, type SprintableDesktop } from './desktop-app';

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
