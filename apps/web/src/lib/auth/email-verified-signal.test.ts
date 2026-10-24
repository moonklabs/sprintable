// @vitest-environment jsdom
// story #4763 AC7 — the «e-mail verified» signal between the tabs of a browser: BroadcastChannel first, the `storage` event second.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VERIFIED_SIGNAL, announceVerified, listenVerified } from './email-verified-signal';

class FakeChannel {
  static all: FakeChannel[] = [];
  name: string; onmessage: ((e: unknown) => void) | null = null; closed = false;
  constructor(name: string) { this.name = name; FakeChannel.all.push(this); }
  postMessage(data: unknown) { for (const c of FakeChannel.all) if (c !== this && !c.closed && c.name === this.name) c.onmessage?.({ data }); }
  close() { this.closed = true; }
}

// Node's own experimental `localStorage` shadows jsdom's in some runs — the test brings its own storage so it measures this module, not the runner
function memoryStorage(throwOnSet = false) {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { if (throwOnSet) throw new Error('blocked'); m.set(k, v); } };
}
beforeEach(() => { FakeChannel.all = []; vi.stubGlobal('BroadcastChannel', FakeChannel); vi.stubGlobal('localStorage', memoryStorage()); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('[SID:4763 AC7] the e-mail verified signal', () => {
  it('announce → a listener in another tab hears it (BroadcastChannel)', () => {
    const heard = vi.fn();
    const stop = listenVerified(heard);
    announceVerified();
    expect(heard).toHaveBeenCalledTimes(1);
    stop();
  });

  it('what goes out is a timestamp and nothing else — no e-mail, token or account (Kadir lens)', () => {
    const heard: unknown[] = [];
    const spy = new FakeChannel(VERIFIED_SIGNAL);
    spy.onmessage = (e) => heard.push((e as { data: unknown }).data);
    announceVerified();
    expect(heard).toHaveLength(1);
    expect(Object.keys(heard[0] as object)).toEqual(['at']);
    expect(typeof (heard[0] as { at: unknown }).at).toBe('number');
    expect(localStorage.getItem(VERIFIED_SIGNAL)).toMatch(/^\d+$/);
  });

  it('announce also writes the storage key (the second way); a storage event with that key is heard, another key is not', () => {
    const heard = vi.fn();
    const stop = listenVerified(heard);
    announceVerified();
    expect(localStorage.getItem(VERIFIED_SIGNAL)).not.toBeNull();
    heard.mockClear();
    window.dispatchEvent(new StorageEvent('storage', { key: VERIFIED_SIGNAL, newValue: '1' }));
    expect(heard).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new StorageEvent('storage', { key: 'other', newValue: '1' }));
    expect(heard).toHaveBeenCalledTimes(1);
    stop();
  });

  it('after stop() nothing is heard and the channel is closed', () => {
    const heard = vi.fn();
    const stop = listenVerified(heard);
    stop();
    announceVerified();
    window.dispatchEvent(new StorageEvent('storage', { key: VERIFIED_SIGNAL, newValue: '1' }));
    expect(heard).not.toHaveBeenCalled();
    expect(FakeChannel.all.filter((c) => !c.closed)).toEqual([]);
  });

  it('a browser with neither way (no BroadcastChannel, storage blocked) stays silent and does not throw', () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    vi.stubGlobal('localStorage', memoryStorage(true));
    expect(() => announceVerified()).not.toThrow();
    const stop = listenVerified(() => undefined);
    expect(() => stop()).not.toThrow();
  });
});
