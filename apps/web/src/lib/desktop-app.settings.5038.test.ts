import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetDesktopAppForTest, desktopAppOf, desktopSettings, desktopSettingsOf, subscribeDesktopSettings, writeDesktopSettings } from '@/lib/desktop-app';

// story 5038 (C8 · B 설정 칸 · web side): reading the app's settings through its closed bridge — exactly the shape, or none.
const S = { kinds: { needs_hand: true, finished: true, failed: true }, thisComputerOff: false, dockBadge: true, trayIcon: true, keepRunning: false };
const base = { inApp: true, device: { name: 'm' }, runtimes: [], pickFolder: async () => null, startHere: async () => ({ ok: true }), setProjectFolder: async () => ({ ok: true }) };
const setBridge = (b: unknown) => { (window as unknown as { sprintableDesktop?: unknown }).sprintableDesktop = b; };
beforeEach(() => { (globalThis as { window?: unknown }).window ??= globalThis; __resetDesktopAppForTest(); setBridge(undefined); });
afterEach(() => { setBridge(undefined); __resetDesktopAppForTest(); });

describe('[SID:5038 C8] desktopSettingsOf — the closed shape or null', () => {
  it('⭐a full shape → a frozen copy (unknown keys dropped)', () => {
    const o = desktopSettingsOf({ ...S, extra: 1, kinds: { ...S.kinds, more: false } })!;
    expect(o).toEqual(S); expect(Object.isFrozen(o)).toBe(true); expect(Object.isFrozen(o.kinds)).toBe(true);
    expect('extra' in o).toBe(false); expect('more' in o.kinds).toBe(false);
  });
  it('⭐every missing or non-boolean piece → null (a half-known shape draws nothing)', () => {
    expect(desktopSettingsOf(undefined)).toBeNull(); expect(desktopSettingsOf(null)).toBeNull(); expect(desktopSettingsOf([])).toBeNull(); expect(desktopSettingsOf('x')).toBeNull();
    for (const f of ['thisComputerOff', 'dockBadge', 'trayIcon', 'keepRunning']) {
      expect(desktopSettingsOf({ ...S, [f]: undefined }), f).toBeNull(); expect(desktopSettingsOf({ ...S, [f]: 'true' }), f).toBeNull(); expect(desktopSettingsOf({ ...S, [f]: 1 }), f).toBeNull();
    }
    for (const k of ['needs_hand', 'finished', 'failed']) expect(desktopSettingsOf({ ...S, kinds: { ...S.kinds, [k]: 0 } }), k).toBeNull();
    expect(desktopSettingsOf({ ...S, kinds: null })).toBeNull(); expect(desktopSettingsOf({ ...S, kinds: [] })).toBeNull();
  });
});

describe('[SID:5038 C8] desktopSettings · desktopAppOf', () => {
  it('a browser · an old app · an app with only part of the hands → null', () => {
    expect(desktopSettings()).toBeNull();
    setBridge({ ...base }); expect(desktopSettings()).toBeNull();
    setBridge({ ...base, settings: S }); expect(desktopSettings()).toBeNull();
    setBridge({ ...base, settings: S, setSettings: async () => ({}) }); expect(desktopSettings()).toBeNull();
  });
  it('⭐a full app → the settings, the SAME object while nothing changed (useSyncExternalStore must not loop)', () => {
    setBridge({ ...base, settings: S, setSettings: async () => ({}), subscribeSettings: () => () => undefined });
    const a = desktopSettings(); expect(a).toEqual(S); expect(desktopSettings()).toBe(a);
  });
  it('⭐a settings hand that is not a function refuses the whole bridge (like the update hands)', () => {
    expect(desktopAppOf({ ...base, setSettings: 1 })).toBeUndefined(); expect(desktopAppOf({ ...base, subscribeSettings: 'x' })).toBeUndefined();
    expect(desktopAppOf({ ...base })).toBeDefined();
  });
});

describe('[SID:5038 C8] subscribeDesktopSettings · writeDesktopSettings', () => {
  it('⭐one subscription to the app is shared; a change is told once; a value off the shape is ignored; the last release lets the app go', () => {
    let emit: (s: unknown) => void = () => undefined; const stop = vi.fn(); const sub = vi.fn((l: (s: unknown) => void) => { emit = l; l(S); return stop; });
    setBridge({ ...base, settings: S, setSettings: async () => ({}), subscribeSettings: sub });
    const a = vi.fn(); const b = vi.fn(); const ua = subscribeDesktopSettings(a); const ub = subscribeDesktopSettings(b);
    expect(sub).toHaveBeenCalledTimes(1);
    emit({ ...S, keepRunning: true }); expect(a).toHaveBeenCalledTimes(1); expect(b).toHaveBeenCalledTimes(1); expect(desktopSettings()!.keepRunning).toBe(true);
    emit({ ...S, keepRunning: true }); expect(a).toHaveBeenCalledTimes(1); // same value: not told again
    emit({ junk: 1 }); expect(a).toHaveBeenCalledTimes(1); expect(desktopSettings()!.keepRunning).toBe(true);
    ua(); expect(stop).not.toHaveBeenCalled(); ub(); expect(stop).toHaveBeenCalledTimes(1);
  });
  it('nothing to subscribe to (no hand) → a no-op that returns a function', () => { setBridge({ ...base }); expect(typeof subscribeDesktopSettings(() => undefined)).toBe('function'); });
  it('⭐write: ok only with the app\'s answer in the closed shape; a refusal · a throw · a bad answer · an old app are named, never thrown', async () => {
    const kept = { ...S, dockBadge: false };
    setBridge({ ...base, settings: S, setSettings: vi.fn(async () => ({ ok: true, settings: kept })), subscribeSettings: () => () => undefined });
    expect(await writeDesktopSettings({ dockBadge: false })).toBe('ok'); expect(desktopSettings()!.dockBadge).toBe(false);
    for (const answer of [{ ok: false, code: 'write_failed' }, { ok: true, settings: { junk: 1 } }, { ok: true }, null, 'x']) {
      __resetDesktopAppForTest(); setBridge({ ...base, settings: S, setSettings: async () => answer, subscribeSettings: () => () => undefined });
      expect(await writeDesktopSettings({ dockBadge: false }), JSON.stringify(answer)).toBe('failed');
      expect(desktopSettings()!.dockBadge).toBe(true);
    }
    setBridge({ ...base, settings: S, setSettings: async () => { throw new Error('x'); }, subscribeSettings: () => () => undefined });
    expect(await writeDesktopSettings({ dockBadge: false })).toBe('failed');
    setBridge({ ...base }); expect(await writeDesktopSettings({ dockBadge: false })).toBe('unsupported');
  });
});

describe('[SID:5038 C8] the store is kept for ONE bridge (codex): another bridge object starts clean', () => {
  const app = (settings: unknown, extra: Record<string, unknown> = {}) => ({ ...base, settings, setSettings: async () => ({ ok: true, settings }), subscribeSettings: () => () => undefined, ...extra });
  it('⭐a replaced bridge: the old one\'s pushed value is gone, the old subscription is let go, the new one is subscribed and read', () => {
    let emitA: (s: unknown) => void = () => undefined; const stopA = vi.fn();
    setBridge(app(S, { subscribeSettings: (l: (s: unknown) => void) => { emitA = l; l(S); return stopA; } }));
    const listen = vi.fn(); subscribeDesktopSettings(listen);
    emitA({ ...S, keepRunning: true }); expect(desktopSettings()!.keepRunning).toBe(true);
    const subB = vi.fn((l: (s: unknown) => void) => { l(S); return () => undefined; });
    setBridge(app({ ...S, trayIcon: false }, { subscribeSettings: subB }));
    expect(desktopSettings()).toEqual({ ...S, trayIcon: false }); // not A's pushed keepRunning
    expect(stopA).toHaveBeenCalledTimes(1);
    subscribeDesktopSettings(listen); expect(subB).toHaveBeenCalledTimes(1); // B is subscribed (A's was let go)
  });
  it('⭐an answer that comes after the bridge was replaced does not touch the new bridge\'s values', async () => {
    let release: (v: unknown) => void = () => undefined;
    const a = app(S, { setSettings: () => new Promise((r) => { release = r; }) }); setBridge(a);
    desktopSettings();
    const pending = writeDesktopSettings({ keepRunning: true });
    setBridge(app({ ...S, dockBadge: false })); expect(desktopSettings()!.dockBadge).toBe(false);
    release({ ok: true, settings: { ...S, keepRunning: true } });
    expect(await pending).toBe('ok');
    expect(desktopSettings()).toEqual({ ...S, dockBadge: false });
  });
});
