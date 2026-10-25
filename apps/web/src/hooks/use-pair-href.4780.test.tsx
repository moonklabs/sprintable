// @vitest-environment jsdom
// story 4780 — every entry to the phone's pairing screen links through `usePairHref`: it carries the page it stands on, so that screen's [Close] can come back to it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('@/hooks/use-flat-href', () => ({ useFlatHref: () => (href: string) => `${href}${href.includes('?') ? '&' : '?'}p=proj-1` }));
const { usePairHref } = await import('./use-pair-href');
const { _locationListenerCountForTests } = await import('@/lib/location-store');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
function Probe() { return <a data-testid="pair" href={usePairHref()}>pair</a>; }
async function hrefAt(url: string): Promise<string | null> {
  window.history.pushState({}, '', url);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(<Probe />); });
  return container.querySelector('a')!.getAttribute('href');
}
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  container?.remove();
  root = null; container = null;
  window.history.pushState({}, '', '/');
});

describe('[SID:4780] usePairHref — the pairing screen\'s address from the page the entry stands on', () => {
  it.each([
    ['Today (the phone card)', '/today?p=proj-1', '/desktop/pair?from=%2Ftoday%3Fp%3Dproj-1&p=proj-1'],
    ['a conversation (the chat head)', '/chats/conv-7?p=proj-1', '/desktop/pair?from=%2Fchats%2Fconv-7%3Fp%3Dproj-1&p=proj-1'],
    ['the inbox', '/inbox?tab=gates&p=proj-1', '/desktop/pair?from=%2Finbox%3Fp%3Dproj-1&p=proj-1'],
    ['the Mac screen (원격 기기)', '/desktop', '/desktop/pair?from=%2Fdesktop&p=proj-1'],
    ['the phone start screen', '/phone-start', '/desktop/pair?from=%2Fphone-start&p=proj-1'],
  ])('%s', async (_name, here, want) => {
    expect(await hrefAt(here)).toBe(want);
  });

  it('a page that is not a return target adds nothing (the address as before)', async () => {
    expect(await hrefAt('/board?p=proj-1')).toBe('/desktop/pair?p=proj-1');
  });

  it('the link follows a navigation once the entry draws again (the address is read at each render)', async () => {
    expect(await hrefAt('/today?p=proj-1')).toBe('/desktop/pair?from=%2Ftoday%3Fp%3Dproj-1&p=proj-1');
    window.history.pushState({}, '', '/inbox');
    await act(async () => { root!.render(<Probe key="again" />); });
    expect(container!.querySelector('a')!.getAttribute('href')).toBe('/desktop/pair?from=%2Finbox&p=proj-1');
  });

  // Kadir lens on 5232: an entry that stays mounted across client navigation (the chat head's strip sits in a layout) must follow the page it is on
  it('a link that stays mounted follows a client-side navigation without being drawn again (pushState · replaceState)', async () => {
    expect(await hrefAt('/today?p=proj-1')).toBe('/desktop/pair?from=%2Ftoday%3Fp%3Dproj-1&p=proj-1');
    await act(async () => { window.history.pushState({}, '', '/inbox'); });
    expect(container!.querySelector('a')!.getAttribute('href')).toBe('/desktop/pair?from=%2Finbox&p=proj-1'); // reverted (no subscription) → still /today
    await act(async () => { window.history.replaceState({}, '', '/chats/conv-7?p=proj-2'); });
    expect(container!.querySelector('a')!.getAttribute('href')).toBe('/desktop/pair?from=%2Fchats%2Fconv-7%3Fp%3Dproj-2&p=proj-1');
  });

  it('Back / Forward (popstate) is followed too', async () => {
    await hrefAt('/today');
    await act(async () => { window.history.pushState({}, '', '/inbox'); });
    expect(container!.querySelector('a')!.getAttribute('href')).toBe('/desktop/pair?from=%2Finbox&p=proj-1');
    const popped = new Promise<void>((resolve) => { window.addEventListener('popstate', () => resolve(), { once: true }); });
    await act(async () => { window.history.back(); await popped; }); // waits for the event itself, not a guessed delay
    expect(container!.querySelector('a')!.getAttribute('href')).toBe('/desktop/pair?from=%2Ftoday&p=proj-1'); // reverted (popstate not listened) → still /inbox
  });

  it('a page that is not a target after the navigation drops the way back; the listener goes with the entry', async () => {
    await hrefAt('/today');
    await act(async () => { window.history.pushState({}, '', '/board'); });
    expect(container!.querySelector('a')!.getAttribute('href')).toBe('/desktop/pair?p=proj-1');
    const during = _locationListenerCountForTests();
    expect(during).toBeGreaterThan(0);
    await act(async () => { root!.unmount(); });
    root = null;
    expect(_locationListenerCountForTests()).toBe(during - 1); // reverted (never unsubscribed) → the count stays
  });

  // codex delta: the store is shared and defensive
  it('a listener that throws neither breaks the navigation nor stops the listeners after it', async () => {
    const { subscribeToLocation } = await import('@/lib/location-store');
    const seen: string[] = [];
    const offBad = subscribeToLocation(() => { throw new Error('bad listener'); });
    const offGood = subscribeToLocation(() => { seen.push(window.location.pathname); });
    try {
      expect(() => window.history.pushState({}, '', '/inbox')).not.toThrow();
      expect(window.location.pathname).toBe('/inbox');
      await Promise.resolve(); // the listeners are told in a microtask
      expect(seen).toEqual(['/inbox']); // the one after the bad one was still told (reverted: no isolation → the bad one stops it)
    } finally {
      offBad();
      offGood();
    }
  });

  // Kadir delta on 5232: Next's app router (HistoryUpdater) calls history.pushState / replaceState INSIDE a `useInsertionEffect`; a listener that makes React schedule an update right there is a React error
  // («useInsertionEffect must not schedule updates») — so the store tells its listeners after the call, not inside it
  it('a navigation made inside a useInsertionEffect (what Next\'s HistoryUpdater does) is followed without React complaining', async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
    const { useInsertionEffect } = await import('react');
    function FakeHistoryUpdater({ to }: { to: string | null }) {
      useInsertionEffect(() => { if (to) window.history.pushState({}, '', to); }, [to]);
      return null;
    }
    try {
      expect(await hrefAt('/today?p=proj-1')).toBe('/desktop/pair?from=%2Ftoday%3Fp%3Dproj-1&p=proj-1');
      await act(async () => { root!.render(<><FakeHistoryUpdater to={null} /><Probe key="p2" /></>); });
      await act(async () => { root!.render(<><FakeHistoryUpdater to="/inbox" /><Probe key="p2" /></>); });
      await act(async () => { await Promise.resolve(); });
      expect(errors.filter((e) => e.includes('useInsertionEffect'))).toEqual([]); // reverted (listeners told inside the call) → «useInsertionEffect must not schedule updates»
      expect(container!.querySelector('a')!.getAttribute('href')).toBe('/desktop/pair?from=%2Finbox&p=proj-1'); // and the link did follow
    } finally {
      spy.mockRestore();
    }
  });

  // Kadir delta on 5232 ②: Next's app router puts the natives back when it unmounts (and in a dev remount); a wrapper installed before that is gone — the next subscription wraps again
  it('after the native history is put back (Next unmounting its router) the next subscription wraps again and the link follows', async () => {
    const native = (method: 'pushState' | 'replaceState') => function (this: History, ...args: Parameters<History['pushState']>) { return History.prototype[method].apply(window.history, args); };
    window.history.pushState = native('pushState'); // the store's wrappers are gone
    window.history.replaceState = native('replaceState');
    expect(await hrefAt('/today?p=proj-1')).toBe('/desktop/pair?from=%2Ftoday%3Fp%3Dproj-1&p=proj-1'); // the entry subscribes on mount
    await act(async () => { window.history.pushState({}, '', '/inbox'); });
    expect(container!.querySelector('a')!.getAttribute('href')).toBe('/desktop/pair?from=%2Finbox&p=proj-1'); // reverted (wrapped once for ever) → still /today
    await act(async () => { window.history.replaceState({}, '', '/chats/conv-7'); });
    expect(container!.querySelector('a')!.getAttribute('href')).toBe('/desktop/pair?from=%2Fchats%2Fconv-7&p=proj-1');
  });

  it('subscribing again while the wrapper is in place adds no layer (every entry that mounts subscribes)', async () => {
    const { subscribeToLocation } = await import('@/lib/location-store');
    const off0 = subscribeToLocation(() => undefined);
    const push = window.history.pushState;
    const replace = window.history.replaceState;
    const offs = Array.from({ length: 20 }, () => subscribeToLocation(() => undefined));
    try {
      expect(window.history.pushState).toBe(push); // reverted (wraps on every subscription) → a new function each time
      expect(window.history.replaceState).toBe(replace);
    } finally {
      offs.forEach((off) => off());
      off0();
    }
  });

  it('something patched over the wrapper (Next patching history after the store) tells a listener once per navigation, not once per layer', async () => {
    const { subscribeToLocation } = await import('@/lib/location-store');
    const off0 = subscribeToLocation(() => undefined); // wrapper in place
    const mine = window.history.pushState;
    window.history.pushState = function (this: History, ...args: Parameters<History['pushState']>) { return mine.apply(this, args); }; // a patch over it
    let told = 0;
    const off = subscribeToLocation(() => { told += 1; }); // wraps again (the wrapper is no longer the one in place)
    try {
      window.history.pushState({}, '', '/inbox');
      await Promise.resolve();
      expect(told).toBe(1); // reverted (not coalesced) → 2: one per layer
    } finally {
      off();
      off0();
    }
  });

  it('a second instance of the module joins the same store: history is wrapped once, a listener is told once', async () => {
    const calls: string[] = [];
    const first = await import('@/lib/location-store');
    const before = first._locationListenerCountForTests();
    const off1 = first.subscribeToLocation(() => { calls.push('first'); });
    vi.resetModules();
    const second = await import('@/lib/location-store'); // a fresh module instance (HMR · a duplicated chunk)
    const off2 = second.subscribeToLocation(() => { calls.push('second'); });
    try {
      window.history.pushState({}, '', '/today');
      await Promise.resolve();
      expect(calls.sort()).toEqual(['first', 'second']); // reverted (state in the module) → the wrapper is wrapped again and each listener is told twice
      expect(second._locationListenerCountForTests()).toBe(before + 2); // ONE store: the second instance sees the first's listener too (reverted → it sees only its own)
    } finally {
      off1();
      off2();
    }
  });
});
